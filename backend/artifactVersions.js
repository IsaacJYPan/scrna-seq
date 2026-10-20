'use strict';

const crypto = require('node:crypto');
const storage = require('./storage');
const previews = require('./artifactPreviews');
const { RETAINED_TYPED_LIMITS, projectRetainedTypedPreview, validateRetainedRasterMetadata } = require('./retainedTypedPreviews');
const { DOWNLOADABLE_ARTIFACT_TYPES, authorizeArtifactDownload } = require('./researchExports');
const { getPrivateRArtifactPolicy } = require('./privateRArtifactPolicy');
const analysisContract = import('../shared/analysisModel.mjs');

const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const WRITE_ROLES = ['owner', 'admin', 'analyst'];
const QUOTA = Object.freeze({ versions: 200, bytes: 5 * 1024 * 1024 * 1024 });
const VERSION_PATTERN = /^(?:av|art|eri)_[a-f0-9]{16,40}$/;
const id = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const canonicalTime = value => new Date(value).toISOString();
function artifactError(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function notFound() { throw artifactError('ARTIFACT_VERSION_NOT_FOUND', 'Artifact version not found.', 404); }
function validBytes(row) { return /^[a-f0-9]{64}$/.test(row.checksum) && Number.isSafeInteger(row.size) && row.size >= 0 && row.key; }

function safeName(value, fallback) {
  const name = String(value || fallback || 'Artifact').trim();
  if (!name || name.length > 160 || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw artifactError('INVALID_ARTIFACT_NAME', 'Artifact name must contain 1–160 characters on one line.');
  return name;
}

function safeFilename(value) {
  const filename = String(value || '').replace(/\\/g, '/').split('/').pop();
  return safeName(filename, 'artifact.bin');
}

function serverImportProvenance(value) {
  const controls = text => [...text].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (!value || value.kind !== 'server-import' || !/^sdi_[a-f0-9]{24}$/.test(value.importId)
      || !/^[a-z][a-z0-9-]{0,63}$/.test(value.rootId) || typeof value.rootLabel !== 'string'
      || !value.rootLabel.trim() || value.rootLabel.length > 80 || controls(value.rootLabel)
      || !/^svc_[a-f0-9]{32}$/.test(value.serviceId) || typeof value.serviceLabel !== 'string'
      || !value.serviceLabel.trim() || value.serviceLabel.length > 80 || controls(value.serviceLabel)
      || !/^[a-f0-9]{64}$/.test(value.sourceSha256) || typeof value.importedAt !== 'string'
      || !Number.isFinite(Date.parse(value.importedAt))) return null;
  try { require('./serverDataImportConfig').relativeSelection(value.relativePath); } catch { return null; }
  let sampleMetadata;
  if (value.sampleMetadata !== undefined) {
    if (!value.sampleMetadata || typeof value.sampleMetadata !== 'object' || Array.isArray(value.sampleMetadata)) return null;
    sampleMetadata = {};
    for (const [key, text] of Object.entries(value.sampleMetadata)) {
      if (!['sampleId','condition','tissue','species','replicate'].includes(key) || typeof text !== 'string'
          || !text.trim() || text.length > 120 || controls(text)) return null;
      sampleMetadata[key] = text;
    }
  }
  return { importId: value.importId, rootId: value.rootId, rootLabel: value.rootLabel,
    relativePath: value.relativePath, serviceId: value.serviceId, serviceLabel: value.serviceLabel,
    sha256: value.sourceSha256, importedAt: canonicalTime(value.importedAt), ...(sampleMetadata ? { sampleMetadata } : {}) };
}

function createArtifactVersionService(db, provider = storage.createLocalStorageProvider()) {
  async function display(row, ownerName) {
    if (!ownerName) ownerName = (await db.query('SELECT display_name FROM users WHERE id=$1', [row.ownerId])).rows[0]?.display_name || 'Researcher';
    let capabilities = previews.previewCapabilities(row.type, row.format, row.size);
    if (row.typedDescriptor?.type === 'metrics' && row.size <= RETAINED_TYPED_LIMITS.sourceJsonBytes) capabilities = ['metrics'];
    if (row.typedDescriptor?.type === 'scatter' && row.size <= RETAINED_TYPED_LIMITS.sourceJsonBytes) capabilities = ['embedding'];
    // Trusted workflow PNGs have their dimensions checked from verified bytes
    // when opened; old descriptors do not retain those dimensions themselves.
    if (row.typedDescriptor?.type === 'figure' && row.size <= previews.PREVIEW_LIMITS.imageBytes) capabilities = ['image'];
    const record = {
      kind: 'artifact-version', schemaVersion: 1, artifactId: row.artifactId, versionId: row.versionId,
      projectId: row.projectId, ownerId: String(row.ownerId), type: row.type, format: row.format,
      sha256: row.checksum, sizeBytes: row.size, storageRef: row.versionId,
      sourceRunId: row.sourceRunId || null, createdAt: canonicalTime(row.createdAt),
      previews: capabilities,
    };
    (await analysisContract).validateArtifactVersion(record);
    const sourceImport = serverImportProvenance(row.provenance);
    return {
      ...record, name: row.name, versionNumber: row.versionNumber || null,
      previousVersionId: row.previousVersionId || null,
      owner: { id: String(row.ownerId), displayName: ownerName },
      source: { kind: row.sourceKind, id: row.sourceId, ...(row.analysisObjectId ? { analysisObjectId: row.analysisObjectId } : {}) },
      reference: { artifactId: record.artifactId, versionId: record.versionId, projectId: record.projectId, sha256: record.sha256 },
      previewBudget: { responseBytes: previews.PREVIEW_LIMITS.bytes, imageBytes: previews.PREVIEW_LIMITS.imageBytes, maximumRows: previews.PREVIEW_LIMITS.rows },
      canReplace: row.sourceKind === 'managed-file',
      ...(row.sourcePublicationId ? { sourcePublicationId: row.sourcePublicationId, provenance: row.provenance } : {}),
      ...(sourceImport ? { sourceImport } : {}),
    };
  }
  function managed(row) {
    return {
      artifactId: row.artifact_id, versionId: row.id, projectId: row.project_id, ownerId: Number(row.owner_user_id),
      name: row.name, type: row.artifact_type, format: row.format_json,
      checksum: row.checksum_sha256, size: Number(row.size_bytes), key: row.storage_key,
      sourceRunId: row.source_job_id, createdAt: row.created_at,
      sourceKind: 'managed-file', sourceId: row.id,
      versionNumber: Number(row.version_number), previousVersionId: row.previous_version_id,
      sourcePublicationId: row.source_publication_id, provenance: row.provenance_json,
    };
  }
  function privateInput(row) {
    const spec = previews.fileFormat(row.original_filename);
    return {
      artifactId: row.id, versionId: row.id, projectId: row.project_id, ownerId: Number(row.owner_user_id),
      name: row.original_filename, type: spec.type, format: { id: spec.id, version: '1' },
      checksum: row.sha256, size: Number(row.file_size_bytes), key: row.internal_storage_key,
      sourceRunId: null, createdAt: row.created_at, sourceKind: 'private-input', sourceId: row.id,
    };
  }
  function workflowOutput(row) {
    const spec = row.descriptor_json;
    const types = { rds: 'object', table: 'table', metrics: 'metrics', scatter: 'coordinates', figure: 'image' };
    const formats = { rds: 'org.r-project.rds', table: 'org.traceomics.table', metrics: 'org.ietf.json', scatter: 'org.traceomics.coordinates', figure: 'org.w3.png' };
    return {
      artifactId: row.id, versionId: row.id, projectId: row.project_id, ownerId: Number(row.owner_user_id),
      name: `Workflow ${spec.type || 'output'} · ${row.id.slice(-8)}`, type: types[spec.type] || 'file', format: { id: formats[spec.type] || 'org.traceomics.opaque-file', version: '1' },
      checksum: spec.sha256, size: Number(spec.sizeBytes), key: row.storage_key,
      sourceRunId: row.job_id, createdAt: row.created_at, sourceKind: 'workflow-output', sourceId: row.id,
      typedDescriptor: spec,
    };
  }
  function jobArtifact(artifact) {
    const checkpoint = ['checkpoint', 'result_checkpoint'].includes(artifact.artifactType);
    const csv = ['deg_markers', 'enrichment_results', 'cellchat_results', 'condition_de_results'].includes(artifact.artifactType);
    return {
      artifactId: artifact.id, versionId: artifact.id, projectId: artifact.projectId, ownerId: artifact.createdByUserId,
      name: artifact.name || (checkpoint ? 'Saved analysis' : artifact.artifactType), type: checkpoint ? 'object' : csv ? 'table' : 'file',
      format: { id: checkpoint ? 'org.traceomics.seurat-checkpoint' : csv ? 'org.ietf.csv' : 'org.traceomics.opaque-file', version: '1' },
      checksum: artifact.checksumSha256, size: artifact.sizeBytes, key: artifact.storageUri,
      sourceRunId: artifact.jobId, createdAt: artifact.createdAt, sourceKind: checkpoint ? 'checkpoint' : 'job-result', sourceId: artifact.id,
      analysisObjectId: artifact.resultAnalysisObjectId || artifact.analysisObjectId,
    };
  }

  async function internal(userId, projectId, versionId, { membershipChecked = false } = {}) {
    if (!membershipChecked) await db.requireProjectRole(userId, projectId, READ_ROLES);
    if (typeof versionId !== 'string' || !VERSION_PATTERN.test(versionId)) notFound();
    let row;
    if (versionId.startsWith('av_')) {
      const result = await db.query('SELECT * FROM managed_artifact_versions WHERE id=$1 AND project_id=$2 AND owner_user_id=$3', [versionId, projectId, userId]);
      if (result.rows[0]) row = managed(result.rows[0]);
    } else if (versionId.startsWith('eri_')) {
      const input = await db.query('SELECT * FROM expert_r_private_inputs WHERE id=$1 AND project_id=$2 AND owner_user_id=$3', [versionId, projectId, userId]);
      if (input.rows[0]) row = privateInput(input.rows[0]);
      else {
        const output = await db.query('SELECT * FROM workflow_artifacts WHERE id=$1 AND project_id=$2 AND owner_user_id=$3', [versionId, projectId, userId]);
        if (output.rows[0]) row = workflowOutput(output.rows[0]);
      }
    } else {
      const artifact = await db.getProjectArtifactInternal(userId, projectId, versionId);
      if (artifact && artifact.status === 'available' && artifact.storageKind === 'local_internal') {
        if (artifact.createdByUserId !== Number(userId)) {
          // Existing downloads have explicit project-sharing checks. Private checkpoints do not inherit metadata visibility.
          if (!DOWNLOADABLE_ARTIFACT_TYPES.has(artifact.artifactType)) notFound();
          await authorizeArtifactDownload(userId, projectId, versionId);
        }
        row = jobArtifact(artifact);
      }
    }
    if (!row || !validBytes(row) || !storage.isProjectStorageKey(row.key, { projectId })) notFound();
    return row;
  }

  async function get(userId, projectId, versionId) { return display(await internal(userId, projectId, versionId)); }

  async function list(userId, projectId, options = {}) {
    await db.requireProjectRole(userId, projectId, READ_ROLES);
    const limit = Number(options.limit ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw artifactError('INVALID_ARTIFACT_PAGE', 'Artifact page size must be 1–100.');
    const before = options.before;
    let cursor;
    if (before) {
      try {
        if (typeof before !== 'string' || before.length > 256) throw new Error();
        cursor = JSON.parse(Buffer.from(String(before), 'base64url').toString('utf8'));
        if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || cursor[0].length > 40 || !Number.isFinite(Date.parse(cursor[0])) || !VERSION_PATTERN.test(cursor[1])) throw new Error();
      } catch { throw artifactError('INVALID_ARTIFACT_PAGE', 'Artifact page cursor is invalid.'); }
    }
    // The cursor and ordering share millisecond precision, matching the public UTC timestamp.
    const timeOrder = "date_trunc('milliseconds',created_at)";
    const cursorClause = cursor ? ` AND (${timeOrder},id)<($4::timestamptz,$5::text)` : '';
    const parameters = [projectId, userId, limit + 1, ...(cursor || [])];
    const candidates = await Promise.all([
      db.query(`SELECT * FROM managed_artifact_versions WHERE project_id=$1 AND owner_user_id=$2${cursorClause} ORDER BY ${timeOrder} DESC,id DESC LIMIT $3`, parameters).then(result => result.rows.map(managed)),
      db.query(`SELECT * FROM expert_r_private_inputs WHERE project_id=$1 AND owner_user_id=$2${cursorClause} ORDER BY ${timeOrder} DESC,id DESC LIMIT $3`, parameters).then(result => result.rows.map(privateInput)),
      db.query(`SELECT * FROM workflow_artifacts WHERE project_id=$1 AND owner_user_id=$2${cursorClause} ORDER BY ${timeOrder} DESC,id DESC LIMIT $3`, parameters).then(result => result.rows.map(workflowOutput)),
      db.query(`SELECT * FROM job_artifacts WHERE project_id=$1 AND created_by_user_id=$2 AND status='available' AND storage_kind='local_internal' AND checksum_sha256 IS NOT NULL${cursorClause} ORDER BY ${timeOrder} DESC,id DESC LIMIT $3`, parameters).then(result => result.rows.map(row => jobArtifact(db.rowToJobArtifact(row)))),
    ]);
    const rows = candidates.flat().filter(row => validBytes(row) && storage.isProjectStorageKey(row.key, { projectId }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.versionId === b.versionId ? 0 : a.versionId < b.versionId ? 1 : -1));
    const selected = rows.slice(0, limit);
    // All listed versions are owned by the authenticated user; fetch the display name once.
    const owner = (await db.query('SELECT display_name FROM users WHERE id=$1', [userId])).rows[0];
    const items = await Promise.all(selected.map(row => display(row, owner?.display_name || 'Researcher')));
    const last = selected.at(-1);
    return { items, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([canonicalTime(last.createdAt), last.versionId])).toString('base64url') : null, limits: previews.PREVIEW_LIMITS };
  }

  async function resolveVerified(userId, projectId, reference, { purpose = 'preview' } = {}) {
    try { (await analysisContract).validateArtifactReference(reference); }
    catch { throw artifactError('INVALID_ARTIFACT_REFERENCE', 'Select an exact artifact version with its project and checksum.'); }
    if (reference.projectId !== String(projectId)) notFound();
    const row = await internal(userId, projectId, reference.versionId);
    if (row.artifactId !== reference.artifactId || row.checksum !== reference.sha256) throw artifactError('ARTIFACT_VERSION_CHANGED', 'The selected artifact reference no longer matches its saved version.', 409);
    if (!['preview', 'execution', 'integrity'].includes(purpose)) throw artifactError('INVALID_ARTIFACT_PURPOSE', 'Artifact access purpose is invalid.');
    if (purpose === 'execution') await db.requireProjectRole(userId, projectId, WRITE_ROLES);
    let opened;
    try {
      opened = await provider.openVerifiedRead(row.key, { checksumSha256: row.checksum, sizeBytes: row.size });
      // Access can be revoked while a large object is being hashed; recheck before handing bytes to a consumer.
      const current = await internal(userId, projectId, reference.versionId);
      if (current.checksum !== row.checksum || current.size !== row.size || current.key !== row.key
          || JSON.stringify(current.typedDescriptor) !== JSON.stringify(row.typedDescriptor)) throw artifactError('ARTIFACT_VERSION_CHANGED', 'The selected artifact version changed during verification.', 409);
      if (purpose === 'execution') await db.requireProjectRole(userId, projectId, WRITE_ROLES);
      return { ...opened, internalStorageKey: row.key, version: await display(row), ...(row.typedDescriptor ? { typedDescriptor: row.typedDescriptor } : {}) };
    } catch (error) {
      if (opened) await opened.handle.close();
      if (['STORAGE_SIZE_MISMATCH', 'STORAGE_CHECKSUM_MISMATCH', 'STORAGE_OBJECT_MISSING', 'UNSAFE_STORAGE_PATH'].includes(error.code)) throw artifactError('ARTIFACT_INTEGRITY_FAILED', 'The saved artifact is missing or its integrity check failed. Earlier versions remain available.', 409);
      throw error;
    }
  }

  async function prefix(opened, maximum) {
    const bytes = Buffer.alloc(Math.min(maximum, opened.stat.size));
    let position = 0;
    while (position < bytes.length) {
      const read = await opened.handle.read(bytes, position, bytes.length - position, position);
      if (!read.bytesRead) break;
      position += read.bytesRead;
    }
    return bytes.subarray(0, position);
  }
  async function completeBytes(opened, version, maximum) {
    if (opened.stat.size > maximum) throw artifactError('ARTIFACT_PREVIEW_INVALID', 'The saved result exceeds this bounded preview.', 413);
    const bytes = await prefix(opened, maximum);
    if (bytes.length !== version.sizeBytes || crypto.createHash('sha256').update(bytes).digest('hex') !== version.sha256) {
      throw artifactError('ARTIFACT_INTEGRITY_FAILED', 'The saved artifact changed while its preview was read.', 409);
    }
    return bytes;
  }
  function raster(bytes, version) {
    if (!['org.w3.png', 'org.iso.jpeg'].includes(version.format.id)) throw artifactError('ARTIFACT_PREVIEW_INVALID', 'A bounded raster preview is unavailable for this version.', 404);
    const dimensions = previews.imageDimensions(bytes.subarray(0, 128 * 1024), version.format.id);
    return validateRetainedRasterMetadata({ formatId: version.format.id, sizeBytes: version.sizeBytes, ...dimensions });
  }
  async function readVerifiedImage(userId, projectId, versionId) {
    const version = await get(userId, projectId, versionId);
    if (!version.previews.includes('image')) throw artifactError('ARTIFACT_PREVIEW_INVALID', 'A bounded image preview is unavailable for this version.', 404);
    const opened = await resolveVerified(userId, projectId, version.reference);
    try {
      const bytes = await completeBytes(opened, version, previews.PREVIEW_LIMITS.imageBytes);
      const dimensions = raster(bytes, version);
      // Recheck after the bounded snapshot, including revocation during reads.
      await recheckOpened(userId, projectId, opened);
      return { version, dimensions, bytes };
    } finally { await opened.handle.close(); }
  }

  async function recheckOpened(userId, projectId, opened) {
    const current = await internal(userId, projectId, opened.version.versionId);
    if (current.checksum !== opened.version.sha256 || current.size !== opened.version.sizeBytes
        || current.key !== opened.internalStorageKey || JSON.stringify(current.typedDescriptor) !== JSON.stringify(opened.typedDescriptor)) {
      throw artifactError('ARTIFACT_VERSION_CHANGED', 'The selected artifact version changed during inspection.', 409);
    }
  }

  async function preview(userId, projectId, versionId, options = {}) {
    const version = await get(userId, projectId, versionId);
    const opened = await resolveVerified(userId, projectId, version.reference);
    try {
      let result;
      try {
        if (['metrics', 'scatter'].includes(opened.typedDescriptor?.type)) {
          if (Object.keys(options).some(key => key.startsWith('pointLimit[') || key.startsWith('pointLimit.'))) throw artifactError('INVALID_ARTIFACT_PAGE', 'Embedding point limit must be one integer from 1 to 5000.');
          const raw = options.pointLimit ?? RETAINED_TYPED_LIMITS.defaultPoints;
          if ((typeof raw !== 'number' && (typeof raw !== 'string' || !/^[0-9]{1,4}$/.test(raw)))
              || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > RETAINED_TYPED_LIMITS.maximumPoints) throw artifactError('INVALID_ARTIFACT_PAGE', 'Embedding point limit must be one integer from 1 to 5000.');
          const overhead = Buffer.byteLength(JSON.stringify({ version, integrityVerified: true, preview: null })) - 4;
          const allowance = RETAINED_TYPED_LIMITS.responseBytes - overhead;
          if (allowance < 1) throw artifactError('ARTIFACT_PREVIEW_INVALID', 'The saved result metadata exceeds the bounded response.', 413);
          result = projectRetainedTypedPreview({ source: version.reference, descriptor: opened.typedDescriptor,
            bytes: await completeBytes(opened, version, RETAINED_TYPED_LIMITS.sourceJsonBytes), pointLimit: Number(raw), responseBytes: allowance });
        } else if (version.previews.includes('image')) {
          try {
            const dimensions = raster(await completeBytes(opened, version, previews.PREVIEW_LIMITS.imageBytes), version);
            result = { family: 'image', width: dimensions.width, height: dimensions.height, boundedBytes: dimensions.boundedBytes };
          } catch (error) {
            if (error.status !== 413) throw error;
            result = { family: 'metadata', message: 'Integrity verified. This complete saved figure exceeds the bounded browser preview.' };
          }
        } else result = version.previews.length ? await previews.buildPreview(opened, version, options) : { family: 'metadata', message: 'Integrity verified. This version supports metadata inspection; its contents require an appropriate private analysis runtime.' };
      }
      catch (error) {
        // The private serializer can save a full data frame whose dimensions or
        // cells exceed browser preview budgets. Preserve those verified bytes.
        if (!version.sourcePublicationId || version.format.id !== 'org.ietf.csv' || error.code !== 'ARTIFACT_PREVIEW_INVALID') throw error;
        result = { family: 'metadata', message: 'Integrity verified. This complete saved table exceeds the bounded browser preview. Inspect it in a private R session.' };
      }
      await recheckOpened(userId, projectId, opened);
      return { version, integrityVerified: true, preview: result };
    }
    finally { await opened.handle.close(); }
  }

  async function importFile(userId, projectId, file, previousVersionId = null) {
    await db.requireProjectRole(userId, projectId, WRITE_ROLES);
    if (!file || typeof file.path !== 'string') throw artifactError('INVALID_ARTIFACT_FILE', 'Select a file to import.');
    const originalFilename = safeFilename(file.originalFilename);
    const name = safeName(file.name, originalFilename);
    if (file.artifactType && !['auto', 'sample-sheet'].includes(file.artifactType)) throw artifactError('INVALID_ARTIFACT_TYPE', 'Choose automatic format detection or a CSV/TSV sample sheet.');
    const spec = await previews.inspectImportedFile({ ...file, originalFilename }, file.artifactType);
    const format = { id: spec.id, version: '1', ...(Object.keys(spec.metadata).length ? { metadata: spec.metadata } : {}) };
    try { (await analysisContract).validateArtifactFormat(format); }
    catch { throw artifactError('INVALID_ARTIFACT_FORMAT', 'Artifact inspection metadata exceeds its supported bounds. Use smaller table headers or a private analysis runtime.', 413); }
    let previous = null;
    if (previousVersionId) {
      previous = await internal(userId, projectId, previousVersionId);
      if (previous.sourceKind !== 'managed-file') throw artifactError('ARTIFACT_VERSION_READ_ONLY', 'Create a new managed artifact to edit an imported result or saved analysis. Existing result versions remain immutable.', 409);
      if (previous.type !== spec.type || previous.format.id !== spec.id) throw artifactError('ARTIFACT_FORMAT_CHANGED', 'A replacement version must retain the artifact format. Import a separate artifact for a different format.', 409);
    }
    const versionId = id('av'); const artifactId = previous?.artifactId || id('af');
    const extension = { 'org.ietf.csv': 'csv', 'org.iana.tsv': 'tsv', 'org.ietf.json': 'json', 'org.ietf.text': 'txt', 'org.w3.png': 'png', 'org.iso.jpeg': 'jpg', 'org.r-project.rds': 'rds' }[spec.id] || 'bin';
    const key = storage.projectStorageFileKey(projectId, 'artifacts', versionId, `content.${extension}`);
    let stored; let committed = false;
    try {
      stored = await provider.putFileFromPath(file.path, key);
      const client = await (await db.connect()).connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
        const membership = (await client.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE', [projectId, userId])).rows[0];
        if (!membership) notFound();
        if (!WRITE_ROLES.includes(membership.role)) throw artifactError('FORBIDDEN', 'Your project role cannot import artifact versions.', 403);
        await assertCapacity(client, userId, projectId, stored.sizeBytes);
        if (previous) {
          const latest = await internal(userId, projectId, previousVersionId);
          if (latest.checksum !== previous.checksum) throw artifactError('ARTIFACT_VERSION_CHANGED', 'The previous artifact version changed during import.', 409);
        }
        const next = (await client.query('SELECT COALESCE(MAX(version_number),0)+1 AS version FROM managed_artifact_versions WHERE artifact_id=$1', [artifactId])).rows[0];
        const inserted = await client.query(`INSERT INTO managed_artifact_versions (id,artifact_id,project_id,owner_user_id,name,version_number,previous_version_id,artifact_type,format_json,mime_type,checksum_sha256,size_bytes,storage_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [versionId, artifactId, projectId, userId, name, Number(next.version), previousVersionId, spec.type, format, spec.mime, stored.checksumSha256, stored.sizeBytes, key]);
        await client.query('COMMIT'); committed = true;
        return display(managed(inserted.rows[0]));
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } finally {
      if (stored && !committed) await provider.remove(key);
    }
  }

  async function capacity(connection, userId, projectId, excludePublicationId = null) {
    const usage = (await connection.query(`SELECT COUNT(*)::int AS count,COALESCE(SUM(bytes),0)::bigint AS bytes FROM (
      SELECT size_bytes AS bytes FROM managed_artifact_versions WHERE project_id=$1 AND owner_user_id=$2
      UNION ALL SELECT reserved_bytes AS bytes FROM private_r_publications WHERE project_id=$1 AND owner_user_id=$2
        AND status IN ('reserved','running','unknown') AND ($3::text IS NULL OR id<>$3)
      UNION ALL SELECT reserved_bytes AS bytes FROM server_data_imports WHERE project_id=$1 AND owner_user_id=$2
        AND status IN ('reserved','running','unknown')
    ) usage`, [projectId, userId, excludePublicationId])).rows[0];
    const availableBytes = Math.max(0, getPrivateRArtifactPolicy().managedQuotaBytes - Number(usage.bytes));
    return { count: Number(usage.count), availableBytes };
  }
  function full() {
    throw artifactError('ARTIFACT_STORAGE_LIMIT', 'Your managed artifact storage is full. Unconfirmed saves reserve space until their completion is resolved.', 409);
  }
  async function assertCapacity(connection, userId, projectId, bytes, excludePublicationId = null) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw artifactError('INVALID_ARTIFACT_FILE', 'The saved artifact size is invalid.');
    const usage = await capacity(connection, userId, projectId, excludePublicationId);
    if (usage.count >= QUOTA.versions || bytes > usage.availableBytes) full();
  }
  async function reserveProducedCapacity(connection, userId, projectId, maximumBytes) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw artifactError('INVALID_ARTIFACT_FILE', 'The saved artifact size limit is invalid.');
    // Serialize producers and imports under the same project lock. The caller
    // retains this exact maximum in its publication row before releasing it.
    await connection.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    const usage = await capacity(connection, userId, projectId);
    if (usage.count >= QUOTA.versions || usage.availableBytes < 1) full();
    return Math.min(maximumBytes, usage.availableBytes);
  }
  async function planProduced(connection, userId, projectId, { type, formatId, previousVersionId }) {
    await connection.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    if (!previousVersionId) return { artifactId: id('af') };
    const previous = (await connection.query('SELECT * FROM managed_artifact_versions WHERE id=$1 AND project_id=$2 AND owner_user_id=$3', [previousVersionId, projectId, userId])).rows[0];
    if (!previous) notFound();
    if (previous.artifact_type !== type || previous.format_json.id !== formatId) throw artifactError('ARTIFACT_FORMAT_CHANGED', 'A replacement version must retain the artifact type and format. Save a separate artifact for a different format.', 409);
    return { artifactId: previous.artifact_id };
  }
  // Server-owned producers call this inside the publication transaction after
  // verifying real bytes. It intentionally accepts no HTTP or client file data.
  async function registerProduced(connection, userId, projectId, value) {
    const plan = await planProduced(connection, userId, projectId, { type: value.type, formatId: value.format.id, previousVersionId: value.previousVersionId });
    if (value.previousVersionId && plan.artifactId !== value.artifactId) throw artifactError('ARTIFACT_VERSION_CHANGED','The previous version no longer matches this artifact.',409);
    if (value.publicationId) {
      const reservation = (await connection.query(`SELECT reserved_bytes FROM private_r_publications
        WHERE id=$1 AND project_id=$2 AND owner_user_id=$3 AND storage_key=$4 AND version_id=$5
          AND status IN ('reserved','running','unknown') FOR UPDATE`,
      [value.publicationId,projectId,userId,value.key,value.versionId])).rows[0];
      if (!reservation || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > Number(reservation.reserved_bytes)) throw artifactError('INVALID_ARTIFACT_FILE','The saved artifact exceeds its retained storage reservation.');
      // This quota was admitted before serialization. A later quota reduction
      // blocks new writes without revoking this exact outstanding reservation.
    } else if (value.importId) {
      const reservation = (await connection.query(`SELECT * FROM server_data_imports
        WHERE id=$1 AND project_id=$2 AND owner_user_id=$3 AND storage_key=$4 AND version_id=$5
          AND artifact_id=$6 AND status='running' AND expires_at>NOW() FOR UPDATE`,
      [value.importId,projectId,userId,value.key,value.versionId,value.artifactId])).rows[0];
      const source = serverImportProvenance(value.provenance);
      if (!reservation || !source || source.importId !== reservation.id
          || source.rootId !== reservation.root_id || source.rootLabel !== reservation.source_metadata_json.root.label
          || source.relativePath !== reservation.relative_path || source.serviceId !== reservation.source_metadata_json.serviceId
          || source.serviceLabel !== reservation.source_metadata_json.serviceLabel
          || source.sha256 !== value.checksumSha256 || value.name !== reservation.name
          || (value.previousVersionId || null) !== reservation.previous_version_id
          || JSON.stringify(source.sampleMetadata || {}) !== JSON.stringify(reservation.source_metadata_json.sampleMetadata || {})
          || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes !== Number(reservation.reserved_bytes)) {
        throw artifactError('INVALID_ARTIFACT_FILE','The imported artifact does not match its retained snapshot reservation.');
      }
    } else await assertCapacity(connection, userId, projectId, value.sizeBytes);
    (await analysisContract).validateArtifactFormat(value.format);
    if (!/^av_[a-f0-9]{24}$/.test(value.versionId) || !/^af_[a-f0-9]{24}$/.test(value.artifactId) || !validBytes({checksum:value.checksumSha256,size:value.sizeBytes,key:value.key}) || !storage.isProjectStorageKey(value.key,{projectId,kind:'artifacts'})) throw artifactError('INVALID_ARTIFACT_FILE','The saved artifact evidence is invalid.');
    const next = (await connection.query('SELECT COALESCE(MAX(version_number),0)+1 AS version FROM managed_artifact_versions WHERE artifact_id=$1', [value.artifactId])).rows[0];
    const inserted = await connection.query(`INSERT INTO managed_artifact_versions
      (id,artifact_id,project_id,owner_user_id,name,version_number,previous_version_id,artifact_type,format_json,mime_type,checksum_sha256,size_bytes,storage_key,source_publication_id,provenance_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [value.versionId,value.artifactId,projectId,userId,safeName(value.name),Number(next.version),value.previousVersionId||null,value.type,value.format,value.mimeType,value.checksumSha256,value.sizeBytes,value.key,value.publicationId,value.provenance]);
    return inserted.rows[0];
  }
  return { list, get, preview, readVerifiedImage, importFile, resolveVerified, assertCapacity, reserveProducedCapacity, planProduced, registerProduced };
}

module.exports = { createArtifactVersionService, VERSION_PATTERN, QUOTA };
