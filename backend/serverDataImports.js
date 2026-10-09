'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const storage = require('./storage');
const previews = require('./artifactPreviews');
const { createArtifactVersionService, VERSION_PATTERN } = require('./artifactVersions');
const { getServiceExecutionIdentity } = require('./executionTargets');
const { getPrivateRArtifactPolicy } = require('./privateRArtifactPolicy');
const { serverDataImportRoots, relativeSelection, importLimits, importError, ROOT_ID } = require('./serverDataImportConfig');
const analysisContract = import('../shared/analysisModel.mjs');
const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const WRITE_ROLES = ['owner', 'admin', 'analyst'];
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const id = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const time = value => new Date(value).toISOString();
const missing = () => importError('SERVER_IMPORT_NOT_FOUND', 'Server data source or import request not found.', 404);
const changed = () => importError('SERVER_IMPORT_SOURCE_CHANGED', 'The source file changed. Refresh the server file list and select it again.', 409);
const unsafe = () => importError('SERVER_IMPORT_PATH_UNSAFE', 'Only ordinary files inside the authorized data root can be imported.', 400);
const line = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeNs: String(stat.mtimeNs ?? Math.round(stat.mtimeMs * 1e6)),
    ctimeNs: String(stat.ctimeNs ?? Math.round(stat.ctimeMs * 1e6)), nlink: Number(stat.nlink) };
}
const sameIdentity = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every(field => left[field] === right[field]);
function assertEntry(stat, directory) {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (!directory && Number(stat.nlink) !== 1)) throw unsafe();
}
function rootFingerprint(root) { return sha(JSON.stringify(root)); }

// Linux walks through retained directory descriptors. Replacing an ancestor
// with a symlink cannot redirect a later child open to a different directory.
// Windows binds the ordinary file handle to the inspected entry and verifies
// the complete ordinary directory chain again before returning it.
async function openSelection(root, relativePath, directory = false) {
  const handles = []; const chain = []; let opened;
  const absolutePath = path.join(root.path, ...relativePath.split('/').filter(Boolean));
  try {
    if (process.platform === 'linux' && fs.existsSync('/proc/self/fd')) {
      const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY;
      let parent = await fs.promises.open('/', flags); handles.push(parent);
      const pieces = [...root.path.split('/').filter(Boolean), ...relativePath.split('/').filter(Boolean)];
      for (let index = 0; index < pieces.length; index++) {
        const isDirectory = directory || index < pieces.length - 1;
        opened = await fs.promises.open(`/proc/self/fd/${parent.fd}/${pieces[index]}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (isDirectory ? fs.constants.O_DIRECTORY : 0));
        handles.push(opened); assertEntry(await opened.stat({ bigint: true }), isDirectory); parent = opened;
      }
      opened = parent;
      const stat = await opened.stat(); const exactStat = await opened.stat({ bigint: true });
      return { handle: opened, stat, identity: identity(exactStat), accessPath: `/proc/self/fd/${opened.fd}`, absolutePath,
        close: async () => { for (const handle of handles.reverse()) await handle.close().catch(() => {}); } };
    }
    const parsed = path.parse(absolutePath); let cursor = parsed.root;
    const pieces = path.relative(parsed.root, absolutePath).split(path.sep).filter(Boolean);
    for (let index = 0; index < pieces.length; index++) {
      cursor = path.join(cursor, pieces[index]);
      const stat = await fs.promises.lstat(cursor, { bigint: true });
      assertEntry(stat, directory || index < pieces.length - 1); chain.push({ path: cursor, identity: identity(stat) });
    }
    if (!directory) {
      opened = await fs.promises.open(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); handles.push(opened);
      const stat = await opened.stat({ bigint: true }); assertEntry(stat, false);
      if (!sameIdentity(identity(stat), chain.at(-1).identity)) throw changed();
    }
    const revalidate = async () => {
      for (let index = 0; index < chain.length; index++) {
        const stat = await fs.promises.lstat(chain[index].path, { bigint: true });
        assertEntry(stat, directory || index < chain.length - 1);
        const current = identity(stat);
        if (directory || index < chain.length - 1) {
          if (current.dev !== chain[index].identity.dev || current.ino !== chain[index].identity.ino) throw changed();
        } else if (!sameIdentity(current, chain[index].identity)) throw changed();
      }
    };
    await revalidate();
    const exactStat = opened ? await opened.stat({ bigint: true }) : await fs.promises.lstat(absolutePath, { bigint: true });
    return { handle: opened, stat: opened ? await opened.stat() : await fs.promises.lstat(absolutePath), identity: identity(exactStat), accessPath: absolutePath, absolutePath, revalidate,
      close: async () => { for (const handle of handles.reverse()) await handle.close().catch(() => {}); } };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => {});
    if (error?.status) throw error;
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) throw missing();
    throw unsafe();
  }
}

function createServerDataImportService(db, provider = storage.createLocalStorageProvider(), options = {}) {
  const env = options.env || process.env;
  const artifacts = createArtifactVersionService(db, provider);
  const processId = crypto.randomBytes(32).toString('hex');
  const signingKey = options.signingKey || sha(`server-data-import:${env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')}`);
  const tasks = new Set();
  const sign = value => crypto.createHmac('sha256', signingKey).update(JSON.stringify(value)).digest('hex');
  function matches(left, right) { return typeof left === 'string' && HASH.test(left) && crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex')); }
  async function access(userId, projectId, write = false) {
    await db.requireProjectRole(userId, projectId, write ? WRITE_ROLES : READ_ROLES);
    if (config.demoMode() || ['demo', 'public'].includes(env.APP_DEPLOYMENT_MODE)) throw importError('SERVER_IMPORT_UNAVAILABLE', 'Server data imports are unavailable in this deployment.', 403);
    const user = (await db.query('SELECT is_demo_guest FROM users WHERE id=$1', [userId])).rows[0];
    if (!user || user.is_demo_guest) throw importError('SERVER_IMPORT_UNAVAILABLE', 'Server data imports are unavailable for this account.', 403);
  }
  function authorizedRoot(userId, projectId, rootId) {
    if (!ROOT_ID.test(rootId || '')) throw missing();
    const root = serverDataImportRoots(env, options.configOptions).find(value => value.id === rootId && value.grants.some(grant => grant.projectId === String(projectId) && grant.ownerUserId === Number(userId)));
    if (!root) throw missing(); return root;
  }
  const selectionToken = (root, userId, projectId, relativePath, statIdentity) => sign([rootFingerprint(root), Number(userId), String(projectId), relativePath, statIdentity]);
  async function roots(userId, projectId) {
    await access(userId, projectId);
    return { roots: serverDataImportRoots(env, options.configOptions).filter(root => root.grants.some(grant => grant.projectId === String(projectId) && grant.ownerUserId === Number(userId))).map(root => ({ id: root.id, label: root.label })), limits: importLimits(env) };
  }
  function pageCursor(value) { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${body}.${sign(body)}`; }
  function cursorValue(raw) {
    try {
      if (typeof raw !== 'string' || raw.length > 1600) throw new Error();
      const [body, signature, extra] = raw.split('.'); if (extra || !matches(signature, sign(body))) throw new Error();
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > 10000) throw new Error(); return parsed;
    } catch { throw importError('SERVER_IMPORT_PAGE_INVALID', 'The server data page expired. Refresh this directory.', 400); }
  }
  async function list(userId, projectId, rootId, query = {}) {
    await access(userId, projectId); const root = authorizedRoot(userId, projectId, rootId);
    if (Object.keys(query).some(key => !['path', 'limit', 'cursor'].includes(key))) throw importError('SERVER_IMPORT_PAGE_INVALID', 'Server data listing accepts only a relative directory and page controls.');
    const relativePath = relativeSelection(query.path, { directory: true }); const limit = Number(query.limit ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw importError('SERVER_IMPORT_PAGE_INVALID', 'Server file page size must be 1–100.');
    const opened = await openSelection(root, relativePath, true); let directory;
    try {
      const scope = sign([rootFingerprint(root), Number(userId), String(projectId), relativePath, opened.identity]);
      const cursor = query.cursor ? cursorValue(query.cursor) : { scope, offset: 0 };
      if (cursor.scope !== scope) throw importError('SERVER_IMPORT_PAGE_CHANGED', 'The server directory changed. Refresh its file list.', 409);
      directory = await fs.promises.opendir(opened.accessPath); const items = []; let examined = 0; let hasMore = false;
      for await (const entry of directory) {
        if (examined >= 10000) { hasMore = true; break; }
        const index = examined++;
        if (index < cursor.offset) continue;
        let selected; try { selected = relativeSelection([relativePath, entry.name].filter(Boolean).join('/')); } catch { continue; }
        const stat = await fs.promises.lstat(path.join(opened.accessPath, entry.name), { bigint: true }).catch(() => null);
        if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || Number(stat.nlink) !== 1))) continue;
        if (items.length === limit) { hasMore = true; examined = index; break; }
        if (stat.isDirectory()) items.push({ name: entry.name, relativePath: selected, kind: 'directory' });
        else if (Number.isSafeInteger(Number(stat.size)) && previews.fileFormat(entry.name).id !== 'org.traceomics.opaque-file') items.push({ name: entry.name, relativePath: selected, kind: 'file', sizeBytes: Number(stat.size), modifiedAt: time(Number(stat.mtimeMs)), selectionToken: selectionToken(root, userId, projectId, selected, identity(stat)) });
      }
      await opened.revalidate?.();
      const current = opened.handle ? identity(await opened.handle.stat({ bigint: true })) : identity(await fs.promises.lstat(opened.absolutePath, { bigint: true }));
      if (!sameIdentity(current, opened.identity)) throw importError('SERVER_IMPORT_PAGE_CHANGED', 'The server directory changed. Refresh its file list.', 409);
      const scanLimitReached = hasMore && examined >= 10000;
      return { root: { id: root.id, label: root.label }, path: relativePath, items,
        nextCursor: hasMore && !scanLimitReached ? pageCursor({ scope, offset: examined }) : null,
        ...(scanLimitReached ? { scanLimitReached: true, message: 'This directory exceeds the bounded listing. Organize files into smaller subdirectories.' } : {}) };
    } finally { if (directory) await directory.close().catch(() => {}); await opened.close(); }
  }
  async function transaction(callback) {
    const connection = await (await db.connect()).connect();
    try { await connection.query('BEGIN'); const result = await callback(connection); await connection.query('COMMIT'); return result; }
    catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
  }
  async function lockedAccess(connection, userId, projectId) {
    const membership = (await connection.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE', [projectId, userId])).rows[0];
    if (!membership) throw missing();
    if (!WRITE_ROLES.includes(membership.role)) throw importError('FORBIDDEN', 'Your current project role cannot import server data.', 403);
  }
  async function expire(userId, projectId) {
    const expired = (await db.query(`UPDATE server_data_imports SET status='failed',error_code='SERVER_IMPORT_INTERRUPTED',error_message='The server import did not finish before its deadline. Its source has not been replayed. Start a new import explicitly.',completed_at=NOW(),updated_at=NOW()
      WHERE project_id=$1 AND owner_user_id=$2 AND status IN ('reserved','running','unknown') AND expires_at<NOW() RETURNING *`, [projectId, userId])).rows;
    for (const row of expired) await cleanupFailed(row);
  }
  async function cleanupFailed(row) {
    // A connection can be lost after COMMIT succeeded. The in-memory flag is
    // insufficient evidence to delete bytes; only a terminal failed operation
    // with no durable version permits cleanup of its exact owned keys.
    try {
      const failed = (await db.query(`SELECT storage_key FROM server_data_imports operation
        WHERE operation.id=$1 AND operation.storage_key=$2 AND operation.status='failed'
          AND NOT EXISTS(SELECT 1 FROM managed_artifact_versions version WHERE version.id=operation.version_id OR version.storage_key=operation.storage_key)`, [row.id, row.storage_key])).rows[0];
      if (failed) await provider.removeImportSnapshot(failed.storage_key);
    } catch { /* Unknown commit outcomes retain their bytes until receipts resolve. */ }
  }
  async function owned(userId, projectId, requestId) {
    if (!REQUEST_ID.test(requestId || '')) throw missing();
    await expire(userId, projectId);
    const row = (await db.query('SELECT * FROM server_data_imports WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3', [projectId, userId, requestId])).rows[0];
    if (!row) throw importError('SERVER_DATA_IMPORT_NOT_FOUND', 'Server import request not found. Its source has not been replayed.', 404);
    if (row.status === 'failed') await cleanupFailed(row);
    return row;
  }
  async function display(row) {
    const status = row.status === 'completed' ? 'succeeded' : row.status === 'failed' ? 'failed' : 'pending';
    return { requestId: row.request_id, status, source: { rootId: row.root_id, relativePath: row.relative_path, name: path.posix.basename(row.relative_path), serviceId: row.source_metadata_json.serviceId, serviceLabel: row.source_metadata_json.serviceLabel, ...(row.source_metadata_json.sampleMetadata ? { sampleMetadata: row.source_metadata_json.sampleMetadata } : {}) },
      reservedBytes: Number(row.reserved_bytes), bytesCopied: Number(row.bytes_copied), createdAt: time(row.created_at), updatedAt: time(row.updated_at), expiresAt: time(row.expires_at),
      ...(status === 'pending' ? { message: 'The server is creating an immutable snapshot. Closing this connection does not restart the import. If the server process stops, this request expires without replaying its source.' } : {}),
      ...(status === 'succeeded' ? { version: await artifacts.get(row.owner_user_id, row.project_id, row.version_id) } : {}),
      ...(status === 'failed' ? { error: { code: row.error_code, message: row.error_message } } : {}) };
  }
  async function get(userId, projectId, requestId) { await access(userId, projectId); return display(await owned(userId, projectId, requestId)); }
  function request(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['requestId', 'rootId', 'relativePath', 'selectionToken', 'name', 'artifactType', 'previousVersionId', 'sampleMetadata'].includes(key))
        || !REQUEST_ID.test(value.requestId || '') || !ROOT_ID.test(value.rootId || '') || !HASH.test(value.selectionToken || '')) throw importError('SERVER_IMPORT_REQUEST_INVALID', 'Select an authorized server file with its current selection token and a request ID.');
    const relativePath = relativeSelection(value.relativePath); const name = value.name ?? path.posix.basename(relativePath);
    if (!line(name, 160)) throw importError('INVALID_ARTIFACT_NAME', 'Artifact name must contain 1–160 characters on one line.');
    const artifactType = value.artifactType || 'auto';
    if (!['auto', 'sample-sheet'].includes(artifactType) || value.previousVersionId != null && !VERSION_PATTERN.test(value.previousVersionId)) throw importError('SERVER_IMPORT_REQUEST_INVALID', 'Select a supported artifact type and an exact previous version.');
    let sampleMetadata;
    if (value.sampleMetadata !== undefined) {
      if (!value.sampleMetadata || typeof value.sampleMetadata !== 'object' || Array.isArray(value.sampleMetadata) || Object.keys(value.sampleMetadata).some(key => !['sampleId', 'condition', 'tissue', 'species', 'replicate'].includes(key) || !line(value.sampleMetadata[key], 120))) throw importError('SERVER_IMPORT_METADATA_INVALID', 'Sample annotations accept sample ID, condition, tissue, species, and replicate as short single-line values.');
      sampleMetadata = Object.fromEntries(Object.entries(value.sampleMetadata).sort(([a], [b]) => a.localeCompare(b)).map(([key, text]) => [key, text.trim()]));
    }
    return { requestId: value.requestId.toLowerCase(), rootId: value.rootId, relativePath, selectionToken: value.selectionToken, name: name.trim(), artifactType, previousVersionId: value.previousVersionId || null, ...(sampleMetadata ? { sampleMetadata } : {}) };
  }
  function publicFailure(error) {
    if (error?.code === 'STORAGE_SOURCE_CHANGED') return { code: 'SERVER_IMPORT_SOURCE_CHANGED', message: 'The source file changed during its snapshot. Refresh the server file list and select it again.' };
    if (error?.status && error.status < 500 && error.code && !['SERVER_IMPORT_CONFIG_INVALID'].includes(error.code)) return { code: error.code, message: error.message };
    return { code: 'SERVER_IMPORT_FAILED', message: 'The server could not finish this snapshot. Earlier artifact versions remain available. Check server storage and start a new import explicitly.' };
  }
  async function snapshot(row, root, opened, spec) {
    let stored; let committed = false; const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Date.parse(row.expires_at) - Date.now())); timer.unref?.();
    try {
      const running = (await db.query("UPDATE server_data_imports SET status='running',updated_at=NOW() WHERE id=$1 AND process_id=$2 AND status='reserved' AND expires_at>NOW() RETURNING *", [row.id, processId])).rows[0];
      if (!running) throw importError('SERVER_IMPORT_INTERRUPTED', 'The server import expired before it could start.', 409);
      await access(row.owner_user_id, row.project_id, true);
      if (rootFingerprint(authorizedRoot(row.owner_user_id, row.project_id, row.root_id)) !== row.source_identity_json.rootFingerprint) throw changed();
      let lastProgress = 0;
      const validateSource = async () => {
        if (!sameIdentity(identity(await opened.handle.stat({ bigint: true })), row.source_identity_json.file)) throw changed();
        const current = await openSelection(root, row.relative_path);
        try { if (!sameIdentity(current.identity, row.source_identity_json.file)) throw changed(); } finally { await current.close(); }
      };
      stored = await provider.putFileFromHandle(opened.handle, row.storage_key, { maxBytes: Number(row.reserved_bytes), expectedStat: opened.stat, signal: controller.signal, validateSource,
        onProgress: async bytes => {
          if (Date.now() - lastProgress < 1000 && bytes !== Number(row.reserved_bytes)) return;
          lastProgress = Date.now();
          await db.query("UPDATE server_data_imports SET bytes_copied=$3,updated_at=NOW() WHERE id=$1 AND process_id=$2 AND status='running' AND expires_at>NOW()", [row.id, processId, bytes]);
        } });
      await validateSource(); await access(row.owner_user_id, row.project_id, true);
      if (rootFingerprint(authorizedRoot(row.owner_user_id, row.project_id, row.root_id)) !== row.source_identity_json.rootFingerprint) throw changed();
      await transaction(async connection => {
        await connection.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [row.project_id]); await lockedAccess(connection, row.owner_user_id, row.project_id);
        const live = (await connection.query("SELECT * FROM server_data_imports WHERE id=$1 AND process_id=$2 AND status='running' AND expires_at>NOW() FOR UPDATE", [row.id, processId])).rows[0];
        if (!live) throw importError('SERVER_IMPORT_INTERRUPTED', 'The server import deadline passed. Its source has not been replayed.', 409);
        if (controller.signal.aborted) throw importError('SERVER_IMPORT_INTERRUPTED', 'The server import deadline passed. Its source has not been replayed.', 409);
        await artifacts.registerProduced(connection, row.owner_user_id, row.project_id, { importId: row.id, versionId: row.version_id, artifactId: row.artifact_id, previousVersionId: row.previous_version_id,
          name: row.name, type: spec.type, format: spec.format, mimeType: spec.mime, key: row.storage_key, checksumSha256: stored.checksumSha256, sizeBytes: stored.sizeBytes,
          provenance: { kind: 'server-import', importId: row.id, rootId: row.root_id, rootLabel: row.source_metadata_json.root.label, relativePath: row.relative_path, sourceSha256: stored.checksumSha256,
            serviceId: row.source_metadata_json.serviceId, serviceLabel: row.source_metadata_json.serviceLabel, importedAt: new Date().toISOString(), ...(row.source_metadata_json.sampleMetadata ? { sampleMetadata: row.source_metadata_json.sampleMetadata } : {}) } });
        await connection.query("UPDATE server_data_imports SET status='completed',bytes_copied=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$1", [row.id, stored.sizeBytes]);
      }); committed = true;
    } catch (error) {
      const failure = publicFailure(controller.signal.aborted ? importError('SERVER_IMPORT_INTERRUPTED', 'The server import did not finish before its deadline. Start a new import explicitly.', 409) : error);
      await db.query("UPDATE server_data_imports SET status='failed',error_code=$3,error_message=$4,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND process_id=$2 AND status IN ('reserved','running','unknown')", [row.id, processId, failure.code, failure.message]).catch(() => {});
    } finally {
      clearTimeout(timer); await opened.close();
      if (!committed) await cleanupFailed(row);
    }
  }
  async function start(userId, projectId, raw) {
    await access(userId, projectId, true); const value = request(raw); const requestSha256 = sha(JSON.stringify(value));
    await expire(userId, projectId);
    const existing = (await db.query('SELECT * FROM server_data_imports WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3', [projectId, userId, value.requestId])).rows[0];
    if (existing) { if (existing.request_sha256 !== requestSha256) throw importError('SERVER_IMPORT_REQUEST_CONFLICT', 'This request ID already describes a different server import. Check its status before starting another.', 409); return display(existing); }
    const root = authorizedRoot(userId, projectId, value.rootId); const opened = await openSelection(root, value.relativePath); let handedOff = false;
    try {
      if (!matches(value.selectionToken, selectionToken(root, userId, projectId, value.relativePath, opened.identity))) throw changed();
      const limits = importLimits(env);
      if (previews.fileFormat(path.posix.basename(value.relativePath)).id === 'org.traceomics.opaque-file') throw importError('SERVER_IMPORT_FORMAT_UNSUPPORTED', 'Select an RDS, CSV, TSV, text, JSON, PNG, or JPEG file. Archives and raw dataset directories require a separate import workflow.');
      if (!Number.isSafeInteger(opened.stat.size) || opened.stat.size < 1 || opened.stat.size > limits.maxFileBytes) throw importError('SERVER_IMPORT_SIZE_LIMIT', 'The selected file is empty or exceeds the server import limit.', 413);
      const inspected = await previews.inspectImportedHandle({ handle: opened.handle, stat: opened.stat, originalFilename: path.posix.basename(value.relativePath) }, value.artifactType, { maxBytes: limits.maxFileBytes });
      const spec = { ...inspected, format: { id: inspected.id, version: '1', ...(Object.keys(inspected.metadata).length ? { metadata: inspected.metadata } : {}) } };
      try { (await analysisContract).validateArtifactFormat(spec.format); }
      catch { throw importError('INVALID_ARTIFACT_FORMAT', 'Artifact inspection metadata exceeds its supported bounds. Use smaller table headers or a private analysis runtime.', 413); }
      const serviceIdentity = await getServiceExecutionIdentity(db);
      const sourceMetadata = { root: { id: root.id, label: root.label }, relativePath: value.relativePath, serviceId: serviceIdentity.id, serviceLabel: serviceIdentity.label, ...(value.sampleMetadata ? { sampleMetadata: value.sampleMetadata } : {}) };
      if (Buffer.byteLength(JSON.stringify(sourceMetadata), 'utf8') > 4096) throw importError('SERVER_IMPORT_METADATA_INVALID', 'The combined server file path and sample annotations exceed the 4 KiB metadata limit. Use shorter annotations or a shorter relative path.', 413);
      const retainedMetadataBytes = Number((await db.query('SELECT octet_length($1::jsonb::text)::int AS bytes', [sourceMetadata])).rows[0].bytes);
      if (retainedMetadataBytes > 4096) throw importError('SERVER_IMPORT_METADATA_INVALID', 'The combined server file path and sample annotations exceed the 4 KiB metadata limit. Use shorter annotations or a shorter relative path.', 413);
      const row = await transaction(async connection => {
        await connection.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]); await lockedAccess(connection, userId, projectId);
        const duplicate = (await connection.query('SELECT * FROM server_data_imports WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3', [projectId, userId, value.requestId])).rows[0];
        if (duplicate) { if (duplicate.request_sha256 !== requestSha256) throw importError('SERVER_IMPORT_REQUEST_CONFLICT', 'This request ID already describes a different server import.', 409); return { duplicate }; }
        await connection.query('SELECT pg_advisory_xact_lock(74108,1)');
        const active = (await connection.query("SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE owner_user_id=$1)::int AS owner FROM server_data_imports WHERE status IN ('reserved','running','unknown') AND expires_at>NOW()", [userId])).rows[0];
        if (Number(active.total) >= 4 || Number(active.owner) >= 2) throw importError('SERVER_IMPORT_BUSY', 'Server imports are busy. Wait for an existing import to finish before starting another.', 409);
        const diskReservations = (await connection.query(`SELECT COALESCE(SUM(bytes),0)::text AS bytes FROM (
          SELECT reserved_bytes AS bytes FROM server_data_imports WHERE status IN ('reserved','running','unknown') AND expires_at>NOW()
          UNION ALL SELECT reserved_bytes AS bytes FROM private_r_publications WHERE status IN ('reserved','running','unknown')
        ) pending`)).rows[0];
        let free;
        try { const available = await fs.promises.statfs(provider.root, { bigint: true }); free = available.bavail * available.bsize; }
        catch { throw importError('SERVER_IMPORT_STORAGE_PRESSURE', 'Server disk capacity cannot be verified. Check server storage before importing.', 503); }
        if (free < BigInt(opened.stat.size) + BigInt(diskReservations.bytes) + BigInt(getPrivateRArtifactPolicy(env).diskReserveBytes)) throw importError('SERVER_IMPORT_STORAGE_PRESSURE', 'Server disk space is insufficient for this complete snapshot. Free server disk space before importing.', 409);
        const admitted = await artifacts.reserveProducedCapacity(connection, userId, projectId, opened.stat.size);
        if (admitted < opened.stat.size) throw importError('ARTIFACT_STORAGE_LIMIT', 'Your managed artifact storage has insufficient room for this complete snapshot.', 409);
        const plan = await artifacts.planProduced(connection, userId, projectId, { type: spec.type, formatId: spec.id, previousVersionId: value.previousVersionId });
        const versionId = id('av'); const importId = id('sdi');
        const extension = { 'org.r-project.rds': 'rds', 'org.ietf.csv': 'csv', 'org.iana.tsv': 'tsv', 'org.ietf.json': 'json', 'org.ietf.text': 'txt', 'org.w3.png': 'png', 'org.iso.jpeg': 'jpg' }[spec.id] || 'bin';
        const key = storage.projectStorageFileKey(projectId, 'artifacts', versionId, `content.${extension}`);
        const inserted = await connection.query(`INSERT INTO server_data_imports
          (id,project_id,owner_user_id,request_id,request_sha256,status,root_id,relative_path,name,artifact_type,previous_version_id,version_id,artifact_id,storage_key,source_identity_json,source_metadata_json,reserved_bytes,process_id,expires_at)
          VALUES($1,$2,$3,$4,$5,'reserved',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW()+($18::text||' seconds')::interval) RETURNING *`,
        [importId, projectId, userId, value.requestId, requestSha256, root.id, value.relativePath, value.name, value.artifactType, value.previousVersionId, versionId, plan.artifactId, key,
          { rootFingerprint: rootFingerprint(root), file: opened.identity }, sourceMetadata, opened.stat.size, processId, limits.transferTimeoutSeconds]);
        return inserted.rows[0];
      });
      if (row.duplicate) return display(row.duplicate);
      handedOff = true;
      const task = snapshot(row, root, opened, spec); tasks.add(task); task.finally(() => tasks.delete(task)).catch(() => {});
      return display(row);
    } finally { if (!handedOff) await opened.close(); }
  }
  return { roots, list, start, get, waitForIdle: async () => { await Promise.all([...tasks]); } };
}

module.exports = { createServerDataImportService, openSelection, identity };
