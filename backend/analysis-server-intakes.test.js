import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { normalizeAnalysisServerIntake, canonicalAnalysisServerIntake, analysisServerIntakeAttachmentRequest } from '../shared/analysisServerIntake.mjs';
import { normalizeAnalysisLocalIntake, canonicalAnalysisLocalIntake } from '../shared/analysisLocalIntake.mjs';
import { canonicalArtifactImportRequest } from '../shared/artifactImport.mjs';

const db = require('./pgDatabase'), storage = require('./storage');
const { createServerDataImportService } = require('./serverDataImports');
const { createAnalysisAttachmentService } = require('./analysisAttachments');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { createArtifactVersionService } = require('./artifactVersions');
const bytes = Buffer.from('gene,score\nA,12\nB,19\n');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const keys = ['STORAGE_ROOT', 'VAULT_ROOT', 'SERVER_DATA_IMPORT_ROOTS', 'APP_DEPLOYMENT_MODE', 'PRIVATE_R_TRANSFER_TIMEOUT_SECONDS', 'PRIVATE_R_MAX_INPUT_FILE_BYTES', 'SESSION_SECRET'];

describe.skipIf(!process.env.DATABASE_URL)('one evidence intake journal with local and granted server adapters', () => {
  let settings, directory, source, provider, http, server, owner, colleague, project, analysis, serviceId, service, copier;
  const activeCopiers = [];
  beforeAll(async () => {
    settings = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'traceomics-server-intake-')); source = path.join(directory, 'sources');
    Object.assign(process.env, { STORAGE_ROOT: path.join(directory, 'managed'), VAULT_ROOT: path.join(directory, 'private'), APP_DEPLOYMENT_MODE: 'private' });
    await fs.mkdir(source); await fs.mkdir(process.env.STORAGE_ROOT); provider = storage.createLocalStorageProvider();
    http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await Promise.all(activeCopiers.map(value => value.waitForIdle())); activeCopiers.length = 0;
    await db.resetSchemaForTests(); process.env.APP_DEPLOYMENT_MODE = 'private'; delete process.env.PRIVATE_R_TRANSFER_TIMEOUT_SECONDS;
    await fs.rm(source, { recursive: true, force: true }); await fs.mkdir(source);
    owner = await http.createUserWithToken({ email: 'server-intake-owner@example.test', displayName: 'Evidence researcher' });
    colleague = await http.createUserWithToken({ email: 'server-intake-colleague@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Intake lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Server evidence' });
    await db.addProjectMember(project.id, colleague.user.id, 'analyst');
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Outside results' })).analysis;
    service = createAnalysisAttachmentService(db, provider); copier = copyService();
    serviceId = (await service.listLocalIntakes(owner.user.id, project.id, analysis.id)).serviceId;
    process.env.SERVER_DATA_IMPORT_ROOTS = JSON.stringify([{ id: 'study', label: 'Granted study data', path: source, grants: [{ projectId: project.id, ownerUserId: owner.user.id }] }]);
  });
  afterAll(async () => {
    await Promise.all(activeCopiers.map(value => value.waitForIdle()));
    if (server) await new Promise(resolve => server.close(resolve)); await db.close();
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  function copyService(database = db, target = provider) { const value = createServerDataImportService(database, target); activeCopiers.push(value); return value; }
  async function recipe(filename = 'result.csv', content = bytes, change = {}) {
    await fs.writeFile(path.join(source, filename), content);
    const listing = await copier.list(owner.user.id, project.id, 'study'), file = listing.items.find(value => value.name === filename), requestId = crypto.randomUUID();
    return normalizeAnalysisServerIntake({ requestId, serviceId, projectId: project.id, ownerUserId: owner.user.id, selectionSizeBytes: content.length,
      importRequest: { requestId, rootId: 'study', relativePath: filename, selectionToken: file.selectionToken, name: 'Server result', artifactType: 'auto' },
      attachment: { requestId: crypto.randomUUID(), action: 'create', attachmentId: null, expectedHeadRevisionId: null, caption: 'Retained outside result', suppliedOrigin: { origin: 'Researcher supplied' } }, ...change });
  }
  function local(requestId = crypto.randomUUID()) { return normalizeAnalysisLocalIntake({ requestId, serviceId,
    importRequest: { schema: 'traceomics.artifact-import.v1', projectId: project.id, ownerUserId: owner.user.id, requestId, originalFilename: 'local.csv', name: 'Local result', artifactType: 'auto', previousVersionId: null, sha256: sha(bytes), sizeBytes: bytes.length },
    attachment: { requestId: crypto.randomUUID(), action: 'create', attachmentId: null, expectedHeadRevisionId: null, caption: 'Local result', suppliedOrigin: {} } }); }
  const base = (a = analysis) => `/api/projects/${project.id}/analyses/${a.id}/attachments`;
  const post = (input, actor = owner, a = analysis) => http.api(server, `${base(a)}/server-intakes`, { method: 'POST', token: actor.token, body: input });
  const get = (requestId, actor = owner, a = analysis) => http.api(server, `${base(a)}/intakes/${requestId}`, { token: actor.token });
  const list = (suffix = '', actor = owner) => http.api(server, `${base()}/intakes${suffix}`, { token: actor.token });
  const count = async table => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
  async function copy(input, value = copier) { await value.start(owner.user.id, project.id, input.importRequest); await value.waitForIdle(); return value.get(owner.user.id, project.id, input.requestId); }
  async function attach(input, receipt, target = service) {
    const body = analysisServerIntakeAttachmentRequest(input, receipt.acceptance);
    return input.attachment.action === 'correct' ? target.correct(owner.user.id, project.id, analysis.id, input.attachment.attachmentId, body) : target.create(owner.user.id, project.id, analysis.id, body);
  }
  async function wrappedDatabase(intercept) {
    const pool = await db.connect(); return { ...db, connect: async () => ({ connect: async () => {
      const client = await pool.connect(); return { query: (sql, values) => intercept(client, sql, values), release: destroy => client.release(destroy) };
    } }) };
  }

  it.each(['csv', 'png'])('admits a frozen %s request before copying and derives its attachment only from exact accepted bytes', async format => {
    const content = format === 'png' ? PNG.sync.write(new PNG({ width: 64, height: 32 })) : bytes;
    const input = await recipe(`real.${format}`, content), admitted = await post(input);
    expect(admitted.status).toBe(201); expect(admitted.data).toMatchObject({ sourceKind: 'server', recipe: input, requestSha256: sha(canonicalAnalysisServerIntake(analysis.id, input)),
      canContinue: true, canStartImport: true, canAttach: true, importOutcome: { status: 'unconfirmed', receipt: null }, attachmentOutcome: { status: 'unconfirmed', receipt: null } });
    for (const table of ['server_data_imports', 'managed_artifact_versions', 'research_analysis_attachments', 'jobs', 'private_r_executions']) expect(await count(table)).toBe(0);
    const saved = await copy(input); expect(saved.acceptance.sha256).toBe(sha(content));
    expect((await get(input.requestId)).data.importOutcome).toMatchObject({ status: 'accepted', receipt: { acceptance: saved.acceptance } });
    const attached = await attach(input, saved), recovered = (await get(input.requestId)).data;
    expect(recovered.attachmentOutcome).toMatchObject({ status: 'accepted', receipt: { acceptedRevision: attached.acceptedRevision } });
    expect((await createResearchAnalysisService().get(owner.user.id, project.id, analysis.id)).analysis.version).toBe(1);
    expect((await list()).data.items[0]).toMatchObject({ sourceKind: 'server', canStartImport: true, importStatus: 'accepted', attachmentStatus: 'accepted', originalFilename: `real.${format}` });
    expect((await http.api(server, `${base()}/local-intakes`, { token: owner.token })).data.items).toEqual([]);
  });

  it('keeps accepted owned attachment permission after source grant/file loss and recovers through a current-reader downgrade', async () => {
    const input = await recipe(); await post(input); const saved = await copy(input);
    await fs.unlink(path.join(source, input.importRequest.relativePath)); process.env.SERVER_DATA_IMPORT_ROOTS = 'invalid configuration';
    const recovered = (await get(input.requestId)).data;
    expect(recovered).toMatchObject({ canContinue: true, canStartImport: false, canAttach: true, importOutcome: { status: 'accepted', receipt: { canImport: true } } });
    const accepted = await attach(input, saved); expect((await post(input)).status).toBe(200);
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    expect((await get(input.requestId)).data).toMatchObject({ canContinue: false, canStartImport: false, canAttach: false,
      importOutcome: { status: 'accepted', receipt: { canImport: false, acceptance: saved.acceptance } }, attachmentOutcome: { status: 'accepted', receipt: { acceptedRevision: accepted.acceptedRevision } } });
    expect((await post(input)).status).toBe(200); expect((await list()).data.items[0].canStartImport).toBe(false);
    const fresh = { ...input, requestId: crypto.randomUUID(), importRequest: { ...input.importRequest, requestId: crypto.randomUUID() } }; fresh.importRequest.requestId = fresh.requestId;
    expect((await post(fresh)).status).toBe(403); expect(await count('research_analysis_intakes')).toBe(1);
  });

  it('preserves shared UUID meaning across local/server sources, analyses and attachment identities', async () => {
    const input = await recipe(), localInput = local(input.requestId); await service.admitLocalIntake(owner.user.id, project.id, analysis.id, localInput);
    process.env.SERVER_DATA_IMPORT_ROOTS = '[]';
    expect((await post(input)).data.code).toBe('ANALYSIS_SERVER_INTAKE_REQUEST_CONFLICT');
    expect((await get(input.requestId)).data.sourceKind).toBe('local');
    const other = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Another analysis' })).analysis;
    expect((await post(input, owner, other)).data.code).toBe('ANALYSIS_SERVER_INTAKE_REQUEST_CONFLICT');
    expect((await get(input.requestId, owner, other)).status).toBe(404);
    expect((await get(input.requestId, colleague)).status).toBe(404); expect((await list('', colleague)).data.items).toEqual([]);
    expect(await count('research_analysis_intakes')).toBe(1); expect(await count('server_data_imports')).toBe(0);
  });

  it('reports changed selections and source policy separately from analysis authority without admitting or copying', async () => {
    const input = await recipe(); await fs.writeFile(path.join(source, input.importRequest.relativePath), 'gene,score\nChanged,1\n');
    expect((await post(input)).data.code).toBe('SERVER_IMPORT_SOURCE_CHANGED');
    process.env.SERVER_DATA_IMPORT_ROOTS = '[]'; expect((await post(input)).data.code).toBe('SERVER_IMPORT_NOT_FOUND');
    expect((await list()).data).toMatchObject({ canContinue: true, canAttach: true, items: [] });
    for (const table of ['research_analysis_intakes', 'server_data_imports', 'managed_artifact_versions']) expect(await count(table)).toBe(0);
  });

  it('honors the smaller configured server limit before admitting an attachment-sized selection', async () => {
    const input = await recipe(); process.env.PRIVATE_R_MAX_INPUT_FILE_BYTES = String(bytes.length - 1);
    try { expect((await post(input)).data.code).toBe('SERVER_INTAKE_SOURCE_SELECTION_INVALID'); expect(await count('research_analysis_intakes')).toBe(0); }
    finally { if (settings.PRIVATE_R_MAX_INPUT_FILE_BYTES === undefined) delete process.env.PRIVATE_R_MAX_INPUT_FILE_BYTES; else process.env.PRIVATE_R_MAX_INPUT_FILE_BYTES = settings.PRIVATE_R_MAX_INPUT_FILE_BYTES; }
  });

  it('performs source I/O before analysis locks and rechecks archive authority before admission', async () => {
    const input = await recipe('preflight.csv'), entered = gate(), release = gate(), nativeOpen = fs.open.bind(fs); let held = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const result = await nativeOpen(...args);
      if (!held && String(args[0]).replaceAll('\\', '/').endsWith('/preflight.csv')) { held = true; entered.resolve(); await release.promise; }
      return result;
    });
    const admission = service.admitServerIntake(owner.user.id, project.id, analysis.id, input); let timer;
    try {
      await entered.promise;
      await Promise.race([createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Source preflight held an analysis lock')), 2000); })]);
    } finally { clearTimeout(timer); release.resolve(); open.mockRestore(); }
    await expect(admission).rejects.toMatchObject({ code: 'ANALYSIS_ARCHIVED' }); expect(await count('research_analysis_intakes')).toBe(0);
  });

  it('shares same-process development selection signing and serializes duplicate admissions without copying', async () => {
    delete process.env.SESSION_SECRET;
    copier = copyService(); service = createAnalysisAttachmentService(db, provider);
    try {
      const input = await recipe(), race = await Promise.all([service.admitServerIntake(owner.user.id, project.id, analysis.id, input), service.admitServerIntake(owner.user.id, project.id, analysis.id, input)]);
      expect(race.map(value => value.replayed).sort()).toEqual([false, true]); expect(await count('research_analysis_intakes')).toBe(1); expect(await count('server_data_imports')).toBe(0);
    } finally { if (settings.SESSION_SECRET === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = settings.SESSION_SECRET; }
  });

  it.each(['admission', 'copy', 'attachment'])('recovers the real committed %s after losing its COMMIT acknowledgement', async stage => {
    const input = await recipe(); let written = false, lost = false;
    const database = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (stage === 'admission' && sql.includes('INSERT INTO research_analysis_intakes') || stage === 'copy' && sql.startsWith("UPDATE server_data_imports SET status='completed'")
          || stage === 'attachment' && sql.includes('INSERT INTO research_analysis_attachment_revisions')) written = true;
      if (sql === 'COMMIT' && written && !lost) { lost = true; throw Object.assign(new Error('Owned fixture loses acknowledgement after real COMMIT'), { code: 'ECONNRESET' }); }
      return result;
    });
    const uncertain = createAnalysisAttachmentService(database, provider);
    if (stage === 'admission') await expect(uncertain.admitServerIntake(owner.user.id, project.id, analysis.id, input)).rejects.toMatchObject({ code: 'ECONNRESET' });
    else await post(input);
    if (stage !== 'admission') {
      const saved = await copy(input, stage === 'copy' ? copyService(database) : copier);
      if (stage === 'attachment') await expect(attach(input, saved, uncertain)).rejects.toMatchObject({ code: 'ECONNRESET' });
    }
    expect(lost).toBe(true);
    const recovered = (await get(input.requestId)).data;
    expect(recovered.requestSha256).toBe(sha(canonicalAnalysisServerIntake(analysis.id, input)));
    expect(recovered.importOutcome.status).toBe(stage === 'admission' ? 'unconfirmed' : 'accepted');
    expect(recovered.attachmentOutcome.status).toBe(stage === 'attachment' ? 'accepted' : 'unconfirmed');
    expect((await post(input)).status).toBe(200); expect(await count('research_analysis_intakes')).toBe(1);
    expect(await count('server_data_imports')).toBe(stage === 'admission' ? 0 : 1);
  });

  it('observes genuine pending, expired and failed copy operations without replaying their source', async () => {
    process.env.PRIVATE_R_TRANSFER_TIMEOUT_SECONDS = '1'; const input = await recipe(), entered = gate(), release = gate(); let copies = 0;
    const held = copyService(db, { ...provider, async putFileFromHandle(...args) { copies++; entered.resolve(); await release.promise; return provider.putFileFromHandle(...args); } });
    await post(input); await held.start(owner.user.id, project.id, input.importRequest); await entered.promise;
    try {
      expect((await get(input.requestId)).data.importOutcome).toMatchObject({ status: 'pending', receipt: { status: 'pending' } });
      await new Promise(resolve => setTimeout(resolve, 1150));
      expect((await get(input.requestId)).data.importOutcome).toMatchObject({ status: 'failed', receipt: { status: 'failed', acceptance: null } });
    } finally { release.resolve(); }
    await held.waitForIdle(); expect(copies).toBe(1); expect(await count('managed_artifact_versions')).toBe(0);
  });

  it('keeps accepted unavailable import evidence and earlier correction receipts separate from the newer head', async () => {
    const first = await recipe('first.csv'); await post(first); const firstCopy = await copy(first), original = await attach(first, firstCopy);
    const correction = await recipe('second.csv', Buffer.from('gene,score\nA,23\n'), { attachment: { ...first.attachment, requestId: crypto.randomUUID(), action: 'correct', attachmentId: original.acceptedRevision.attachmentId, expectedHeadRevisionId: original.acceptedRevision.id, caption: 'Corrected source' } });
    await post(correction); const secondCopy = await copy(correction), corrected = await attach(correction, secondCopy);
    const newer = await service.correct(owner.user.id, project.id, analysis.id, corrected.acceptedRevision.attachmentId, { ...analysisServerIntakeAttachmentRequest(correction, secondCopy.acceptance), requestId: crypto.randomUUID(), expectedHeadRevisionId: corrected.acceptedRevision.id, caption: 'Later deliberate context' });
    const old = (await get(correction.requestId)).data;
    expect(old.attachmentOutcome.receipt.acceptedRevision.id).toBe(corrected.acceptedRevision.id); expect(old.attachmentOutcome.receipt.attachment.headRevisionId).toBe(newer.acceptedRevision.id);
    const unlinked = await recipe('unlinked.csv'); await post(unlinked); const saved = await copy(unlinked), row = (await db.query('SELECT storage_key FROM server_data_imports WHERE request_id=$1', [unlinked.requestId])).rows[0];
    await db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [saved.acceptance.versionId]); await fs.unlink(provider.resolveKey(row.storage_key));
    expect((await get(unlinked.requestId)).data.importOutcome).toMatchObject({ status: 'accepted', receipt: { acceptance: saved.acceptance, availability: 'unavailable', version: null } });
  });

  it('renames the v29 local journal once and preserves every literal local hash, row and closed route', async () => {
    const input = local(), accepted = await service.admitLocalIntake(owner.user.id, project.id, analysis.id, input), before = (await db.query('SELECT * FROM research_analysis_intakes')).rows[0];
    await db.query('ALTER TABLE research_analysis_intakes DROP COLUMN source_kind'); await db.query('ALTER TABLE research_analysis_intakes RENAME TO research_analysis_local_intakes');
    await db.query("UPDATE app_schema_contract SET schema_version=20261029 WHERE schema_key='traceomics.runtime'");
    await db.initSchema({ force: true }); await db.initSchema({ force: true });
    const recovered = await service.getLocalIntake(owner.user.id, project.id, analysis.id, input.requestId), row = (await db.query('SELECT * FROM research_analysis_intakes')).rows[0];
    expect(recovered).toEqual({ ...accepted, replayed: true }); expect(row).toEqual({ ...before, source_kind: 'local' });
    expect((await db.query("SELECT to_regclass('research_analysis_local_intakes') AS old, (SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime') AS version")).rows[0]).toEqual({ old: null, version: 20261031 });
    await expect(db.query("UPDATE research_analysis_intakes SET source_kind='server' WHERE request_id=$1", [input.requestId])).rejects.toMatchObject({ code: '55000' });
    const remote = await recipe(); expect((await post(remote)).status).toBe(201);
    const oldList = (await http.api(server, `${base()}/local-intakes`, { token: owner.token })).data;
    expect(oldList.items).toHaveLength(1); expect(oldList.items[0].requestId).toBe(input.requestId); expect(oldList).toHaveProperty('canUpload', true); expect(oldList).not.toHaveProperty('sourceKind'); expect(oldList.items[0]).not.toHaveProperty('sourceKind');
    expect((await list()).data.items).toHaveLength(2);
  });

  it('keeps valid 200-unit and legacy control-containing profile labels readable through local aliases and unified recovery', async () => {
    const input = local(); await service.admitLocalIntake(owner.user.id, project.id, analysis.id, input);
    const file = path.join(directory, crypto.randomUUID()); await fs.writeFile(file, bytes);
    await createArtifactVersionService(db, provider).importFile(owner.user.id, project.id, { path: file, originalFilename: input.importRequest.originalFilename, name: input.importRequest.name, artifactType: 'auto', requestId: input.requestId, expectedRequestSha256: sha(canonicalArtifactImportRequest(input.importRequest)) });
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [owner.user.id, 'r'.repeat(200)]);
    const accepted = await service.getLocalIntake(owner.user.id, project.id, analysis.id, input.requestId);
    expect(accepted.importOutcome.receipt.version.owner.displayName).toBe('r'.repeat(200));
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [owner.user.id, '\n\u202e' + '🧬'.repeat(200)]);
    const current = (await get(input.requestId)).data;
    expect(current.importOutcome.receipt.version.owner.displayName.length).toBeLessThanOrEqual(200); expect(current.importOutcome.receipt.version.owner.displayName.isWellFormed()).toBe(true);
    expect(current.importOutcome.receipt.version.owner.displayName).not.toMatch(/[\p{Cc}\p{Cf}]/u); expect(current.requestSha256).toBe(accepted.requestSha256); expect(current.recipe).toEqual(accepted.recipe);
  });

  it('keeps missing legacy acceptance explicit without fabricating an attachable checksum', async () => {
    const input = await recipe(); await post(input); const saved = await copy(input);
    await db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [saved.acceptance.versionId]);
    await db.query('DROP TRIGGER trg_server_data_import_identity ON server_data_imports');
    await db.query('ALTER TABLE server_data_imports DROP COLUMN request_json, DROP COLUMN acceptance_json');
    await db.initSchema({ force: true });
    expect((await get(input.requestId)).data.importOutcome).toMatchObject({ status: 'legacy-unrecorded', receipt: { status: 'succeeded', request: null, acceptance: null, acceptanceState: 'legacy-unrecorded', version: null } });
    expect((await get(input.requestId)).data.attachmentOutcome).toEqual({ status: 'unconfirmed', receipt: null });
  });

  it('reports missing historical source metadata as conflict while surfacing unexpected read faults', async () => {
    const input = await recipe(); await post(input); await copy(input);
    for (const property of ['source_identity_json', 'source_metadata_json']) {
      const database = await wrappedDatabase(async (client, sql, values) => {
        const result = await client.query(sql, values);
        if (!sql.includes('FROM server_data_imports') || !sql.includes('request_id=ANY')) return result;
        return { ...result, rows: result.rows.map(row => ({ ...row, [property]: {} })) };
      });
      const observed = await createAnalysisAttachmentService(database, provider).getServerIntake(owner.user.id, project.id, analysis.id, input.requestId);
      expect(observed.importOutcome).toEqual({ status: 'conflict', receipt: null }); expect(observed.attachmentOutcome).toEqual({ status: 'unconfirmed', receipt: null });
    }
    const fault = new TypeError('Owned fixture source metadata adapter fault');
    const database = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (!sql.includes('FROM server_data_imports') || !sql.includes('request_id=ANY')) return result;
      return { ...result, rows: result.rows.map(row => Object.defineProperty({ ...row }, 'source_identity_json', { get() { throw fault; } })) };
    });
    await expect(createAnalysisAttachmentService(database, provider).getServerIntake(owner.user.id, project.id, analysis.id, input.requestId)).rejects.toBe(fault);
    expect(await count('server_data_imports')).toBe(1); expect(await count('research_analysis_attachments')).toBe(0); expect(await count('jobs')).toBe(0);
  });

  it('pages one ordered mixed-source collection while keeping source-filtered aliases closed', async () => {
    for (let index = 0; index < 2; index++) { await service.admitLocalIntake(owner.user.id, project.id, analysis.id, local()); await post(await recipe(`page-${index}.csv`)); }
    const first = (await list('?limit=2')).data, second = (await list('?limit=2&cursor=' + encodeURIComponent(first.nextCursor))).data;
    expect(first.items).toHaveLength(2); expect(second.items).toHaveLength(2); expect(second.nextCursor).toBeNull(); expect(new Set([...first.items, ...second.items].map(value => value.requestId)).size).toBe(4);
    expect(new Set([...first.items, ...second.items].map(value => value.sourceKind))).toEqual(new Set(['local', 'server']));
    const remote = await http.api(server, `${base()}/server-intakes`, { token: owner.token }); expect(remote.data.items).toHaveLength(2); expect(remote.data.items.every(value => value.sourceKind === 'server')).toBe(true);
  });

  it('shares the admission quota and attachment UUID constraint across both source adapters', async () => {
    const input = await recipe(), values = Array.from({ length: 1999 }, () => local());
    await db.query(`INSERT INTO research_analysis_intakes(project_id,analysis_id,owner_user_id,request_id,attachment_request_id,service_id,request_sha256,recipe_json)
      SELECT $1,$2,$3,request_id,attachment_request_id,$4,request_sha256,recipe_json FROM jsonb_to_recordset($5::jsonb) AS x(request_id uuid,attachment_request_id uuid,request_sha256 text,recipe_json jsonb)`,
    [project.id, analysis.id, owner.user.id, serviceId, JSON.stringify(values.map(value => ({ request_id: value.requestId, attachment_request_id: value.attachment.requestId, request_sha256: sha(canonicalAnalysisLocalIntake(analysis.id, value)), recipe_json: value })))]);
    const extra = local(), race = await Promise.allSettled([service.admitServerIntake(owner.user.id, project.id, analysis.id, input), service.admitLocalIntake(owner.user.id, project.id, analysis.id, extra)]);
    expect(race.filter(value => value.status === 'fulfilled')).toHaveLength(1); expect(race.find(value => value.status === 'rejected').reason.code).toMatch(/ANALYSIS_(LOCAL|SERVER)_INTAKE_LIMIT/); expect(await count('research_analysis_intakes')).toBe(2000);
    expect((await service.admitLocalIntake(owner.user.id, project.id, analysis.id, values[0])).replayed).toBe(true);
    const conflictId = crypto.randomUUID(), sharedAttachment = { ...input, requestId: conflictId, importRequest: { ...input.importRequest, requestId: conflictId }, attachment: { ...input.attachment, requestId: values[0].attachment.requestId } };
    await expect(service.admitServerIntake(owner.user.id, project.id, analysis.id, sharedAttachment)).rejects.toMatchObject({ code: 'ANALYSIS_SERVER_INTAKE_REQUEST_CONFLICT' });
  });

  it('keeps original archive/demo outcomes readable, denies new actions and performs only scoped demo cleanup', async () => {
    const input = await recipe(); await post(input); const saved = await copy(input); await attach(input, saved);
    await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' });
    expect((await get(input.requestId)).data).toMatchObject({ canContinue: false, canStartImport: false, canAttach: false, importOutcome: { status: 'accepted', receipt: { canImport: true } } });
    expect((await post(input)).status).toBe(200);
    process.env.APP_DEPLOYMENT_MODE = 'demo'; expect((await get(input.requestId)).data.importOutcome.status).toBe('accepted'); process.env.APP_DEPLOYMENT_MODE = 'private';
    const organization = await db.createOrganizationForUser(colleague.user.id, { name: 'Retained lab' }), retainedProject = await db.createProjectForUser(colleague.user.id, { organizationId: organization.id, name: 'Retained project' });
    const retained = (await createResearchAnalysisService().create(colleague.user.id, retainedProject.id, { requestId: crypto.randomUUID(), name: 'Retained analysis' })).analysis;
    const requestId = crypto.randomUUID(), kept = { ...local(requestId), importRequest: { ...local(requestId).importRequest, projectId: retainedProject.id, ownerUserId: colleague.user.id } };
    await service.admitLocalIntake(colleague.user.id, retainedProject.id, retained.id, kept);
    await db.query("UPDATE users SET is_demo_guest=TRUE,expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [owner.user.id]); expect(await db.deleteExpiredDemoGuest(owner.user.id)).toBe(true);
    expect(await count('research_analysis_intakes')).toBe(1); expect((await service.getLocalIntake(colleague.user.id, retainedProject.id, retained.id, requestId)).recipe).toEqual(kept);
  });
});
