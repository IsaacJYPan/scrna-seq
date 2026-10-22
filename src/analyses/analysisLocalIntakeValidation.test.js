import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalAnalysisLocalIntake, normalizeAnalysisLocalIntake, analysisLocalIntakeAttachmentRequest } from '../../shared/analysisLocalIntake.mjs';
import { canonicalAnalysisAttachmentContent, canonicalAnalysisAttachmentCorrection } from '../../shared/analysisAttachment.mjs';
import { canonicalArtifactImportRequest } from '../artifacts/artifactImportReceipt';
import { validateAnalysisLocalIntake, validateAnalysisLocalIntakeList } from './analysisLocalIntakeValidation';

const scope = { serviceId: `svc_${'1'.repeat(32)}`, projectId: `proj_${'2'.repeat(24)}`, analysisId: `ra_${'3'.repeat(24)}`, userId: 7 };
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attachRequestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const artifactId = `af_${'4'.repeat(24)}`, versionId = `av_${'5'.repeat(24)}`, attachmentId = `raa_${'6'.repeat(24)}`;
const firstRevisionId = `rar_${'7'.repeat(24)}`, acceptedRevisionId = `rar_${'8'.repeat(24)}`, laterRevisionId = `rar_${'9'.repeat(24)}`;
const emptyOrigin = { origin: null, sourceReference: null, documentReference: null, environmentReference: null };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fileSha = sha256('gene,score\nA,2');
const recipe = (action = 'create') => ({ requestId, serviceId: scope.serviceId,
  importRequest: { schema: 'traceomics.artifact-import.v1', projectId: scope.projectId, ownerUserId: 7, requestId,
    originalFilename: 'scores.csv', name: 'Outside scores', artifactType: 'auto', previousVersionId: null, sha256: fileSha, sizeBytes: 14 },
  attachment: { requestId: attachRequestId, action, attachmentId: action === 'correct' ? attachmentId : null,
    expectedHeadRevisionId: action === 'correct' ? firstRevisionId : null, caption: 'Outside treatment scores', suppliedOrigin: { ...emptyOrigin } } });
const common = { serviceId: scope.serviceId, projectId: scope.projectId, analysisId: scope.analysisId, ownerUserId: 7,
  canContinue: true, canUpload: true, canAttach: true };
const unconfirmed = () => ({ status: 'unconfirmed', receipt: null });
function full(action = 'create') {
  const value = recipe(action);
  return { ...common, requestId, requestSha256: sha256(canonicalAnalysisLocalIntake(scope.analysisId, value)), recipe: value,
    createdAt: '2026-10-20T12:00:00.000Z', replayed: false, importOutcome: unconfirmed(), attachmentOutcome: unconfirmed() };
}
function imported(value = recipe()) {
  const request = structuredClone(value.importRequest);
  const acceptance = { artifactId, versionId, versionNumber: 1, previousVersionId: null, sha256: fileSha, sizeBytes: 14,
    createdAt: '2026-10-20T12:00:01.000Z' };
  return { requestId: request.requestId, status: 'succeeded', canImport: true, requestSha256: sha256(canonicalArtifactImportRequest(request)), request, acceptance,
    availability: 'recorded', version: { kind: 'artifact-version', schemaVersion: 1, artifactId, versionId, projectId: scope.projectId,
      ownerId: '7', name: request.name, type: 'table', format: { id: 'org.ietf.csv', version: '1' }, sha256: fileSha, sizeBytes: 14,
      storageRef: versionId, sourceRunId: null, createdAt: acceptance.createdAt, previews: ['table'], versionNumber: 1, previousVersionId: null,
      owner: { id: '7', displayName: 'Researcher' }, source: { kind: 'managed-file', id: versionId },
      reference: { artifactId, versionId, projectId: scope.projectId, sha256: fileSha },
      previewBudget: { responseBytes: 1048576, imageBytes: 10485760, maximumRows: 100 }, canReplace: true } };
}
function attached(value = recipe(), acceptance = imported(value).acceptance) {
  const input = analysisLocalIntakeAttachmentRequest(value, acceptance), correction = value.attachment.action === 'correct';
  const revision = { id: acceptedRevisionId, attachmentId, revisionNumber: correction ? 2 : 1,
    previousRevisionId: correction ? value.attachment.expectedHeadRevisionId : null, reference: input.reference,
    caption: input.caption, suppliedOrigin: input.suppliedOrigin, createdByUserId: 7, createdAt: '2026-10-20T12:00:02.000Z' };
  return { projectId: scope.projectId, analysisId: scope.analysisId, canWrite: true, requestId: input.requestId,
    requestSha256: sha256(correction ? canonicalAnalysisAttachmentCorrection(attachmentId, input) : canonicalAnalysisAttachmentContent(input)),
    replayed: true, acceptedRevision: revision, acceptedSourceAccess: 'available',
    attachment: { id: attachmentId, headRevisionId: revision.id, revision: structuredClone(revision), sourceAccess: 'available' } };
}
function complete(action = 'create') {
  const value = full(action); value.importOutcome = { status: 'accepted', receipt: imported(value.recipe) };
  value.attachmentOutcome = { status: 'accepted', receipt: attached(value.recipe) }; return value;
}
const item = () => ({ requestId, requestSha256: full().requestSha256, createdAt: '2026-10-20T12:00:00.000Z', originalFilename: 'scores.csv',
  name: 'Outside scores', caption: 'Outside treatment scores', action: 'create', attachmentId: null, expectedHeadRevisionId: null,
  importStatus: 'unconfirmed', attachmentStatus: 'unconfirmed' });
const list = () => ({ ...common, items: [item()], nextCursor: null });
const invalid = { code: 'INVALID_ANALYSIS_LOCAL_INTAKE_RESPONSE' };
const rehash = value => { value.requestSha256 = sha256(canonicalAnalysisLocalIntake(scope.analysisId, value.recipe)); return value; };

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

it.each(['R'.repeat(161), 'R'.repeat(200), '🧬'.repeat(100)])('recovers accepted local evidence for a valid account display label of %s', async displayName => {
  const result = complete(), originalHash = result.requestSha256, originalAcceptance = structuredClone(result.importOutcome.receipt.acceptance);
  result.importOutcome.receipt.version.owner.displayName = displayName;
  const value = await validateAnalysisLocalIntake(result, scope);
  expect(value.importOutcome.receipt.version.owner.displayName).toBe(displayName);
  expect(value.requestSha256).toBe(originalHash); expect(value.importOutcome.receipt.acceptance).toEqual(originalAcceptance);
});
it.each(['R'.repeat(201), '🧬'.repeat(101), 'R'.repeat(199) + '🧬', 'Research\0name', 'Research\nname', 'Research\u007fname', '  '])('rejects an invalid returned profile label %s without weakening saved evidence identity', async displayName => {
  const result = complete(); result.importOutcome.receipt.version.owner.displayName = displayName;
  await expect(validateAnalysisLocalIntake(result, scope)).rejects.toMatchObject(invalid);
});

it('discovers a bounded private list under current owner/project/analysis, learning service identity only when no prior service is bound', () => {
  const discovery = { projectId: scope.projectId, analysisId: scope.analysisId, userId: '7' };
  const result = list(), value = validateAnalysisLocalIntakeList(result, discovery);
  expect(value).toEqual(result); expect(value).not.toBe(result); expect(value.items[0]).not.toBe(result.items[0]);
  expect(value.serviceId).toBe(scope.serviceId);
  expect(validateAnalysisLocalIntakeList(result, scope)).toEqual(result);
});

it('accepts a 30-item newest-first page with request UUID tie ordering and an explicit opaque cursor', () => {
  const result = list(); result.nextCursor = 'eyJwYWdlIjoxfQ';
  result.items = Array.from({ length: 30 }, (_, index) => ({ ...item(), requestId: `${(30 - index).toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` }));
  expect(validateAnalysisLocalIntakeList(result, scope).items).toHaveLength(30);
  result.items = []; result.nextCursor = null; expect(validateAnalysisLocalIntakeList(result, scope).items).toEqual([]);
});

it.each([
  ['wrong service', value => { value.serviceId = `svc_${'9'.repeat(32)}`; }],
  ['wrong project', value => { value.projectId = `proj_${'9'.repeat(24)}`; }],
  ['wrong analysis', value => { value.analysisId = `ra_${'9'.repeat(24)}`; }],
  ['wrong owner', value => { value.ownerUserId = 8; }],
  ['coerced owner', value => { value.ownerUserId = '7'; }],
  ['missing authority', value => { delete value.canContinue; }],
  ['coerced authority', value => { value.canUpload = 'true'; }],
  ['unequal current capability flags', value => { value.canAttach = false; }],
  ['private source field', value => { value.path = '/private/file'; }],
  ['unknown summary source', value => { value.items[0].fileBytes = [1, 2]; }],
  ['wrong UUID', value => { value.items[0].requestId = 'request'; }],
  ['malformed digest', value => { value.items[0].requestSha256 = 'A'.repeat(64); }],
  ['source path filename', value => { value.items[0].originalFilename = '../scores.csv'; }],
  ['unsupported format', value => { value.items[0].originalFilename = 'object.rds'; }],
  ['unnormalized name', value => { value.items[0].name = ' Outside scores '; }],
  ['unnormalized caption', value => { value.items[0].caption = ' Outside scores '; }],
  ['oversized caption', value => { value.items[0].caption = 'x'.repeat(2001); }],
  ['caption hidden control', value => { value.items[0].caption = 'Question\u0000'; }],
  ['invalid action', value => { value.items[0].action = 'replace'; }],
  ['create with correction target', value => { value.items[0].attachmentId = attachmentId; }],
  ['correction without frozen predecessor', value => { value.items[0].action = 'correct'; value.items[0].attachmentId = attachmentId; }],
  ['unknown import status', value => { value.items[0].importStatus = 'missing'; }],
  ['unproved attachment success', value => { value.items[0].attachmentStatus = 'accepted'; }],
  ['invalid date', value => { value.items[0].createdAt = '2026-02-30T12:00:00.000Z'; }],
  ['oversized page', value => { value.items = Array(31).fill(value.items[0]); }],
  ['duplicate requests', value => { value.items.push(structuredClone(value.items[0])); }],
  ['oldest-first page', value => { value.items.push({ ...item(), requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: '2026-10-20T12:00:01.000Z' }); }],
  ['wrong same-time UUID order', value => { value.items.push({ ...item(), requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }); }],
  ['missing cursor', value => { delete value.nextCursor; }],
  ['oversized cursor', value => { value.nextCursor = 'a'.repeat(257); }],
  ['nonopaque cursor', value => { value.nextCursor = '/private/path'; }],
  ['empty continuing page', value => { value.items = []; value.nextCursor = 'next'; }],
])('rejects discovery with %s', (_label, mutate) => {
  const result = list(); mutate(result);
  expect(() => validateAnalysisLocalIntakeList(result, scope)).toThrow(expect.objectContaining(invalid));
});

it.each(['unconfirmed', 'conflict'])('preserves %s outcomes without inventing an import or attachment acceptance', async status => {
  const result = full(); result.importOutcome.status = status; result.attachmentOutcome.status = status;
  const value = await validateAnalysisLocalIntake(result, scope, recipe());
  expect(value.importOutcome).toEqual({ status, receipt: null }); expect(value.attachmentOutcome).toEqual({ status, receipt: null });
  expect(value.recipe).toEqual(recipe()); expect(value.recipe).not.toBe(result.recipe);
});

it('preserves canonical import v1 order/UUID hashing while binding the intake schema, server, owner, analysis and both frozen steps', async () => {
  const result = full(); const canonicalImport = JSON.stringify(result.recipe.importRequest);
  expect(canonicalArtifactImportRequest(result.recipe.importRequest)).toBe(canonicalImport);
  const canonical = JSON.stringify({ schema: 'traceomics.analysis-local-intake.v1', serviceId: scope.serviceId, projectId: scope.projectId,
    analysisId: scope.analysisId, ownerUserId: 7, requestId, importRequest: result.recipe.importRequest, attachment: result.recipe.attachment });
  expect(canonicalAnalysisLocalIntake(scope.analysisId, result.recipe)).toBe(canonical);
  const reordered = { ...result, recipe: Object.fromEntries(Object.entries(result.recipe).reverse()) };
  await expect(validateAnalysisLocalIntake(reordered, scope)).resolves.toMatchObject({ requestSha256: sha256(canonical) });
  expect(sha256(canonicalArtifactImportRequest({ ...result.recipe.importRequest, requestId: attachRequestId }))).not.toBe(sha256(canonicalImport));
});

it.each(['create', 'correct'])('binds accepted %s to the exact imported version/hash and normalized frozen context', async action => {
  const result = complete(action), value = await validateAnalysisLocalIntake(result, scope, recipe(action));
  expect(value.importOutcome.receipt.acceptance.versionId).toBe(versionId);
  expect(value.attachmentOutcome.receipt.acceptedRevision.reference).toEqual({ kind: 'artifact-version', versionId, sha256: fileSha });
  expect(value.attachmentOutcome.receipt.acceptedRevision.caption).toBe(result.recipe.attachment.caption);
  expect(value.attachmentOutcome.receipt.acceptedRevision.previousRevisionId).toBe(action === 'correct' ? firstRevisionId : null);
  expect(value.importOutcome.receipt.version).not.toBe(result.importOutcome.receipt.version);
});

it('recovers accepted original correction under reader/archived authority while keeping a newer different current head separate', async () => {
  const result = complete('correct'); result.canContinue = false; result.canUpload = false; result.canAttach = false; result.replayed = true;
  const receipt = result.attachmentOutcome.receipt; receipt.canWrite = false;
  receipt.attachment = { id: attachmentId, headRevisionId: laterRevisionId, sourceAccess: 'restricted', revision: {
    ...receipt.acceptedRevision, id: laterRevisionId, revisionNumber: 4, previousRevisionId: `rar_${'f'.repeat(24)}`,
    reference: { kind: 'artifact-version', versionId: `av_${'b'.repeat(24)}`, sha256: 'b'.repeat(64) },
    caption: 'A newer collaborator correction', createdByUserId: 9 } };
  const value = await validateAnalysisLocalIntake(result, { ...scope, userId: '7' }, recipe('correct'));
  expect(value.canAttach).toBe(false); expect(value.importOutcome.receipt.canImport).toBe(true);
  expect(value.attachmentOutcome.receipt.acceptedRevision.id).toBe(acceptedRevisionId);
  expect(value.attachmentOutcome.receipt.attachment.headRevisionId).toBe(laterRevisionId);
  expect(value.attachmentOutcome.receipt.attachment.sourceAccess).toBe('restricted');
});

it('preserves import and attachment acceptance when the original bytes disappear, without providing a replacement upload claim', async () => {
  const result = complete(); result.importOutcome.receipt.availability = 'unavailable'; result.importOutcome.receipt.version = null;
  result.attachmentOutcome.receipt.acceptedSourceAccess = 'unavailable'; result.attachmentOutcome.receipt.attachment.sourceAccess = 'unavailable';
  const value = await validateAnalysisLocalIntake(result, scope);
  expect(value.importOutcome.receipt).toMatchObject({ availability: 'unavailable', version: null, acceptance: { versionId, sha256: fileSha } });
  expect(value.attachmentOutcome.receipt.acceptedSourceAccess).toBe('unavailable');
});

it.each([
  ['wrong server', value => { value.serviceId = `svc_${'9'.repeat(32)}`; value.recipe.serviceId = value.serviceId; rehash(value); }],
  ['wrong owner despite a matching recipe digest', value => { value.recipe.importRequest.ownerUserId = 8; rehash(value); }],
  ['wrong recipe project', value => { value.recipe.importRequest.projectId = `proj_${'9'.repeat(24)}`; rehash(value); }],
  ['wrong analysis', value => { value.analysisId = `ra_${'9'.repeat(24)}`; }],
  ['wrong intake UUID', value => { value.requestId = attachRequestId; }],
  ['unknown envelope field', value => { value.canWrite = true; }],
  ['missing receipt replay state', value => { delete value.replayed; }],
  ['coerced replay state', value => { value.replayed = 'true'; }],
  ['changed recipe hash', value => { value.requestSha256 = '0'.repeat(64); }],
  ['unknown recipe bytes', value => { value.recipe.fileBytes = [1, 2, 3]; }],
  ['unknown recipe source path', value => { value.recipe.importRequest.path = '/private/source'; }],
  ['same UUID for two frozen steps', value => { value.recipe.attachment.requestId = requestId; }],
  ['different intake/import UUID', value => { value.recipe.importRequest.requestId = attachRequestId; }],
  ['replacement import', value => { value.recipe.importRequest.previousVersionId = versionId; }],
  ['unsupported RDS import', value => { value.recipe.importRequest.originalFilename = 'object.rds'; }],
  ['explicit sample sheet purpose', value => { value.recipe.importRequest.artifactType = 'sample-sheet'; }],
  ['oversized file', value => { value.recipe.importRequest.sizeBytes = 25 * 1024 * 1024 + 1; }],
  ['unnormalized recipe caption', value => { value.recipe.attachment.caption = ' Outside treatment scores '; }],
  ['incomplete nullable origin', value => { delete value.recipe.attachment.suppliedOrigin.origin; }],
  ['unknown origin execution claim', value => { value.recipe.attachment.suppliedOrigin.executed = true; }],
  ['missing intake time', value => { delete value.createdAt; }],
  ['invalid intake time', value => { value.createdAt = 'today'; }],
  ['accepted status without receipt', value => { value.importOutcome.status = 'accepted'; }],
  ['unknown outcome', value => { value.importOutcome.status = 'missing'; }],
  ['outcome diagnostic source path', value => { value.importOutcome.path = '/private/source'; }],
  ['accepted attachment without accepted import', value => { value.attachmentOutcome = { status: 'accepted', receipt: attached(value.recipe) }; }],
  ['conflict adopting an unrelated accepted receipt', value => { value.importOutcome = { status: 'conflict', receipt: imported(value.recipe) }; }],
])('leaves a full intake unconfirmed for %s', async (_label, mutate) => {
  const result = full(); mutate(result);
  await expect(validateAnalysisLocalIntake(result, scope)).rejects.toMatchObject(invalid);
});

it.each([
  ['changed import UUID', value => { value.importOutcome.receipt.requestId = attachRequestId; }],
  ['changed import hash', value => { value.importOutcome.receipt.requestSha256 = '0'.repeat(64); }],
  ['changed file size', value => { value.importOutcome.receipt.acceptance.sizeBytes = 15; }],
  ['changed file checksum', value => { value.importOutcome.receipt.acceptance.sha256 = 'b'.repeat(64); }],
  ['unexpected import version number', value => { value.importOutcome.receipt.acceptance.versionNumber = 2; }],
  ['different current source owner', value => { value.importOutcome.receipt.version.ownerId = '8'; }],
  ['private version field', value => { value.importOutcome.receipt.version.storageKey = '/private/file'; }],
  ['unsupported actual file format', value => { value.importOutcome.receipt.version.format.id = 'org.ietf.json'; }],
  ['wrong format/type correspondence', value => { value.importOutcome.receipt.version.type = 'image'; }],
  ['changed source kind', value => { value.importOutcome.receipt.version.source.kind = 'private-input'; }],
  ['wrong source identity', value => { value.importOutcome.receipt.version.reference.versionId = `av_${'f'.repeat(24)}`; }],
  ['unavailable with surviving version object', value => { value.importOutcome.receipt.availability = 'unavailable'; }],
  ['recorded with missing version', value => { value.importOutcome.receipt.version = null; }],
  ['import acceptance extra host path', value => { value.importOutcome.receipt.acceptance.path = '/private'; }],
  ['changed attachment UUID', value => { value.attachmentOutcome.receipt.requestId = requestId; }],
  ['changed accepted attachment source', value => { value.attachmentOutcome.receipt.acceptedRevision.reference.versionId = `av_${'f'.repeat(24)}`; }],
  ['changed accepted attachment notes', value => { value.attachmentOutcome.receipt.acceptedRevision.suppliedOrigin.origin = 'Other researcher notes'; }],
  ['changed accepted actor', value => { value.attachmentOutcome.receipt.acceptedRevision.createdByUserId = 8; }],
  ['malformed accepted source access', value => { value.attachmentOutcome.receipt.acceptedSourceAccess = 'public'; }],
  ['changed current attachment identity', value => { value.attachmentOutcome.receipt.attachment.id = `raa_${'f'.repeat(24)}`; }],
  ['unknown receipt authority', value => { value.attachmentOutcome.receipt.canUpload = true; }],
  ['source bytes in accepted revision', value => { value.attachmentOutcome.receipt.acceptedRevision.bytes = [1, 2]; }],
])('rejects accepted outcomes with %s', async (_label, mutate) => {
  const result = complete(); mutate(result);
  await expect(validateAnalysisLocalIntake(result, scope)).rejects.toMatchObject(invalid);
});

it('requires a known current service for exact reads and never accepts a different expected original recipe or correction predecessor', async () => {
  const discovery = { projectId: scope.projectId, analysisId: scope.analysisId, userId: 7 };
  await expect(validateAnalysisLocalIntake(full(), discovery)).rejects.toMatchObject(invalid);
  const changed = recipe(); changed.attachment.caption = 'A different draft with the same UUID';
  await expect(validateAnalysisLocalIntake(full(), scope, changed)).rejects.toMatchObject(invalid);
  const result = complete('correct'); result.attachmentOutcome.receipt.acceptedRevision.previousRevisionId = laterRevisionId;
  await expect(validateAnalysisLocalIntake(result, scope, recipe('correct'))).rejects.toMatchObject(invalid);
});

it('normalizes the caller original recipe but requires the server echo to be fully normalized', async () => {
  const draft = recipe(); draft.requestId = requestId.toUpperCase(); draft.importRequest.requestId = requestId.toUpperCase();
  draft.attachment.requestId = attachRequestId.toUpperCase(); draft.attachment.caption = '  Outside treatment scores\r\nNotes  ';
  draft.attachment.suppliedOrigin.origin = '  Supplied outside lab  ';
  const result = full(); result.recipe = normalizeAnalysisLocalIntake(draft); rehash(result);
  await expect(validateAnalysisLocalIntake(result, scope, draft)).resolves.toMatchObject({ recipe: { attachment: { caption: 'Outside treatment scores\nNotes' } } });
  result.recipe.attachment.caption = draft.attachment.caption;
  await expect(validateAnalysisLocalIntake(result, scope, draft)).rejects.toMatchObject(invalid);
});

it('rejects non-JSON/accessor/hidden/symbol/sparse data without evaluating getters or exposing its private diagnostic', async () => {
  const getter = vi.fn(() => 'private');
  const badList = list(); Object.defineProperty(badList.items[0], 'name', { enumerable: true, get: getter });
  expect(() => validateAnalysisLocalIntakeList(badList, scope)).toThrow(expect.objectContaining(invalid));
  const sparse = list(); sparse.items = Array(1); expect(() => validateAnalysisLocalIntakeList(sparse, scope)).toThrow(expect.objectContaining(invalid));
  for (const result of [Object.create(full()), Object.defineProperty(full(), 'serviceId', { enumerable: true, get: getter }),
    Object.defineProperty(full(), 'secret', { value: 'private' }), Object.assign(full(), { [Symbol('secret')]: true })]) {
    await expect(validateAnalysisLocalIntake(result, scope)).rejects.toMatchObject(invalid);
  }
  const nested = complete(); Object.defineProperty(nested.importOutcome.receipt.version.format, 'metadata', { enumerable: true, get: getter });
  await expect(validateAnalysisLocalIntake(nested, scope)).rejects.toMatchObject(invalid); expect(getter).not.toHaveBeenCalled();
});

it('keeps a digest failure unconfirmed and does not return raw outcomes that mutate while the fingerprint is being checked', async () => {
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockRejectedValueOnce(new Error('Unavailable')) } });
  await expect(validateAnalysisLocalIntake(full(), scope)).rejects.toMatchObject(invalid);
  let release;
  const result = full(), bytes = createHash('sha256').update(canonicalAnalysisLocalIntake(scope.analysisId, result.recipe)).digest();
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn(() => new Promise(resolve => { release = () => resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); })) } });
  const pending = validateAnalysisLocalIntake(result, scope);
  result.canAttach = false; result.attachmentOutcome.status = 'accepted'; result.recipe.attachment.caption = 'Changed after validation began';
  release();
  await expect(pending).resolves.toMatchObject({ canAttach: true, recipe: { attachment: { caption: 'Outside treatment scores' } }, attachmentOutcome: unconfirmed() });
});
