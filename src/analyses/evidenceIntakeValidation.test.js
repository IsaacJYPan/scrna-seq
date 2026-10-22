import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalAnalysisLocalIntake, normalizeAnalysisLocalIntake, analysisLocalIntakeAttachmentRequest } from '../../shared/analysisLocalIntake.mjs';
import { canonicalAnalysisServerIntake, normalizeAnalysisServerIntake, analysisServerIntakeAttachmentRequest } from '../../shared/analysisServerIntake.mjs';
import { canonicalAnalysisAttachmentContent, canonicalAnalysisAttachmentCorrection } from '../../shared/analysisAttachment.mjs';
import { canonicalArtifactImportRequest } from '../../shared/artifactImport.mjs';
import { canonicalServerDataImportRequest } from '../../shared/serverDataImport.mjs';
import { validateEvidenceIntake, validateEvidenceIntakeList } from './evidenceIntakeValidation';
import { validateAnalysisLocalIntake, validateAnalysisLocalIntakeList } from './analysisLocalIntakeValidation';

const scope = { serviceId: 'svc_' + '1'.repeat(32), projectId: 'proj_' + '2'.repeat(24), analysisId: 'ra_' + '3'.repeat(24), userId: 7 };
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attachmentRequestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const artifactId = 'af_' + '4'.repeat(24), versionId = 'av_' + '5'.repeat(24), attachmentId = 'raa_' + '6'.repeat(24);
const firstRevisionId = 'rar_' + '7'.repeat(24), acceptedRevisionId = 'rar_' + '8'.repeat(24), laterRevisionId = 'rar_' + '9'.repeat(24);
const operationId = 'sdi_' + 'a'.repeat(24);
const sha = value => createHash('sha256').update(value).digest('hex'), fileSha = sha('gene,score\nA,2');
const emptyOrigin = () => ({ origin: null, sourceReference: null, documentReference: null, environmentReference: null });
const context = action => ({ requestId: attachmentRequestId, action, attachmentId: action === 'correct' ? attachmentId : null,
  expectedHeadRevisionId: action === 'correct' ? firstRevisionId : null, caption: 'Outside treatment scores', suppliedOrigin: emptyOrigin() });
const common = () => ({ serviceId: scope.serviceId, projectId: scope.projectId, analysisId: scope.analysisId, ownerUserId: 7, canContinue: true, canAttach: true });
const unknown = () => ({ status: 'unconfirmed', receipt: null });
const invalid = { code: 'INVALID_EVIDENCE_INTAKE_RESPONSE' };
const recipe = (kind = 'server', action = 'create') => kind === 'server'
  ? normalizeAnalysisServerIntake({ requestId, serviceId: scope.serviceId, projectId: scope.projectId, ownerUserId: 7,
    importRequest: { requestId, rootId: 'lab-data', relativePath: 'study/scores.csv', selectionToken: 'd'.repeat(64), name: 'Outside scores' },
    selectionSizeBytes: 14, attachment: context(action) })
  : normalizeAnalysisLocalIntake({ requestId, serviceId: scope.serviceId,
    importRequest: { schema: 'traceomics.artifact-import.v1', projectId: scope.projectId, ownerUserId: 7, requestId,
      originalFilename: 'scores.csv', name: 'Outside scores', artifactType: 'auto', previousVersionId: null, sha256: fileSha, sizeBytes: 14 }, attachment: context(action) });
const canonical = (kind, value) => kind === 'server' ? canonicalAnalysisServerIntake(scope.analysisId, value) : canonicalAnalysisLocalIntake(scope.analysisId, value);
const rehash = value => { value.requestSha256 = sha(canonical(value.sourceKind, value.recipe)); return value; };
function full(kind = 'server', action = 'create') {
  const value = recipe(kind, action);
  return { sourceKind: kind, ...common(), canStartImport: true, requestId, requestSha256: sha(canonical(kind, value)), recipe: value,
    createdAt: '2026-10-22T12:00:00.000Z', replayed: false, importOutcome: unknown(), attachmentOutcome: unknown() };
}
function acceptance() {
  return { artifactId, versionId, versionNumber: 1, previousVersionId: null, sha256: fileSha, sizeBytes: 14, createdAt: '2026-10-22T12:00:01.000Z' };
}
function version(value) {
  return { kind: 'artifact-version', schemaVersion: 1, artifactId, versionId, projectId: scope.projectId, ownerId: '7',
    name: value.importRequest.name, type: 'table', format: { id: 'org.ietf.csv', version: '1' }, sha256: fileSha, sizeBytes: 14,
    storageRef: versionId, sourceRunId: null, createdAt: acceptance().createdAt, previews: ['table'], versionNumber: 1, previousVersionId: null,
    owner: { id: '7', displayName: 'Researcher' }, source: { kind: 'managed-file', id: versionId },
    reference: { artifactId, versionId, projectId: scope.projectId, sha256: fileSha },
    previewBudget: { responseBytes: 262144, imageBytes: 5242880, maximumRows: 100 }, canReplace: true };
}
function localReceipt(value) {
  return { requestId, status: 'succeeded', canImport: true, requestSha256: sha(canonicalArtifactImportRequest(value.importRequest)),
    request: structuredClone(value.importRequest), acceptance: acceptance(), availability: 'recorded', version: version(value) };
}
function serverReceipt(value, status = 'accepted') {
  const request = structuredClone(value.importRequest);
  const result = { projectId: scope.projectId, ownerUserId: 7, serviceId: scope.serviceId, canImport: true,
    id: operationId, requestId, requestSha256: sha(canonicalServerDataImportRequest(request)), request, name: request.name,
    status: 'pending', replayed: true, source: { rootId: request.rootId, relativePath: request.relativePath, name: 'scores.csv',
      serviceId: scope.serviceId, serviceLabel: 'Research server' }, reservedBytes: 14, bytesCopied: 7,
    createdAt: '2026-10-22T12:00:00.000Z', updatedAt: '2026-10-22T12:00:01.000Z', expiresAt: '2026-10-22T12:15:00.000Z',
    acceptanceState: 'not-accepted', acceptance: null, availability: 'not-recorded', version: null, error: null,
    message: 'The server is copying and verifying the original source.' };
  if (status === 'failed') Object.assign(result, { status: 'failed', message: null, error: { code: 'SERVER_IMPORT_SOURCE_CHANGED', message: 'The source changed while copying.' } });
  if (status === 'accepted' || status === 'legacy-unrecorded') Object.assign(result, { status: 'succeeded', bytesCopied: 14, message: null,
    acceptanceState: status === 'accepted' ? 'recorded' : 'legacy-unrecorded', acceptance: status === 'accepted' ? acceptance() : null,
    availability: status === 'accepted' ? 'recorded' : 'unavailable', version: status === 'accepted' ? version(value) : null });
  if (status === 'legacy-unrecorded') result.request = null;
  if (result.version) result.version.sourceImport = { importId: operationId, rootId: request.rootId, rootLabel: 'Granted study data',
    relativePath: request.relativePath, serviceId: scope.serviceId, serviceLabel: result.source.serviceLabel, sha256: fileSha, importedAt: result.updatedAt };
  return result;
}
function attached(record, imported) {
  const value = record.recipe, correction = value.attachment.action === 'correct';
  const request = record.sourceKind === 'server' ? analysisServerIntakeAttachmentRequest(value, imported) : analysisLocalIntakeAttachmentRequest(value, imported);
  const revision = { id: acceptedRevisionId, attachmentId, revisionNumber: correction ? 2 : 1,
    previousRevisionId: correction ? value.attachment.expectedHeadRevisionId : null, reference: request.reference, caption: request.caption,
    suppliedOrigin: request.suppliedOrigin, createdByUserId: 7, createdAt: '2026-10-22T12:00:02.000Z' };
  return { projectId: scope.projectId, analysisId: scope.analysisId, canWrite: true, requestId: request.requestId,
    requestSha256: sha(correction ? canonicalAnalysisAttachmentCorrection(attachmentId, request) : canonicalAnalysisAttachmentContent(request)),
    replayed: true, acceptedRevision: revision, acceptedSourceAccess: 'available',
    attachment: { id: attachmentId, headRevisionId: revision.id, revision: structuredClone(revision), sourceAccess: 'available' } };
}
function complete(kind = 'server', action = 'create') {
  const result = full(kind, action), copied = kind === 'server' ? serverReceipt(result.recipe) : localReceipt(result.recipe);
  result.importOutcome = { status: 'accepted', receipt: copied };
  result.attachmentOutcome = { status: 'accepted', receipt: attached(result, copied.acceptance) }; return result;
}
function item(kind = 'server') {
  const value = full(kind);
  return { sourceKind: kind, canStartImport: true, requestId, requestSha256: value.requestSha256, createdAt: value.createdAt,
    originalFilename: 'scores.csv', name: value.recipe.importRequest.name, caption: value.recipe.attachment.caption, action: 'create', attachmentId: null,
    expectedHeadRevisionId: null, importStatus: 'unconfirmed', attachmentStatus: 'unconfirmed' };
}
const list = (items = [item()]) => ({ ...common(), items, nextCursor: null });
const legacyFull = value => { const { sourceKind: _kind, canStartImport, ...rest } = value; return { ...rest, canUpload: canStartImport }; };
const legacyList = value => ({ ...common(), canUpload: value.canContinue,
  items: value.items.map(({ sourceKind: _kind, canStartImport: _start, ...rest }) => rest), nextCursor: value.nextCursor });

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

it('discovers one bounded mixed-source collection and binds the current owner, project, analysis and learned service', () => {
  const result = list([item('server'), { ...item('local'), requestId: '00000000-0000-4000-8000-000000000001' }]);
  result.items[0].canStartImport = false;
  const value = validateEvidenceIntakeList(result, { projectId: scope.projectId, analysisId: scope.analysisId, userId: '7' });
  expect(value).toEqual(result); expect(value).not.toBe(result); expect(value.items[0]).not.toBe(result.items[0]);
  expect(validateEvidenceIntakeList(result, scope)).toEqual(result);
  expect(validateEvidenceIntakeList(list([]), scope).items).toEqual([]);
});
it('keeps the exact existing local list and full validation semantics under only the new tag/transfer-name wrapper', async () => {
  const result = complete('local', 'correct'), expected = { sourceKind: 'local', recipe: result.recipe };
  const beforeHash = result.requestSha256, old = await validateAnalysisLocalIntake(legacyFull(result), scope, result.recipe);
  const value = await validateEvidenceIntake(result, scope, expected);
  expect(legacyFull(value)).toEqual(old); expect(value.requestSha256).toBe(beforeHash);
  const page = list([item('local')]);
  expect(legacyList(validateEvidenceIntakeList(page, scope))).toEqual(validateAnalysisLocalIntakeList(legacyList(page), scope));
  expect(canonicalAnalysisLocalIntake(scope.analysisId, value.recipe)).toBe(canonicalAnalysisLocalIntake(scope.analysisId, result.recipe));
});
it('recovers a valid 200-unit account label through the unchanged local wire and canonical evidence identity', async () => {
  const result = complete('local'); result.importOutcome.receipt.version.owner.displayName = 'R'.repeat(200);
  const original = result.requestSha256, accepted = structuredClone(result.importOutcome.receipt.acceptance);
  const value = await validateEvidenceIntake(result, scope);
  expect(value.importOutcome.receipt.version.owner.displayName).toHaveLength(200);
  expect(value.requestSha256).toBe(original); expect(value.importOutcome.receipt.acceptance).toEqual(accepted);
});
it.each(['local', 'server'])('requires an already-bound service for an exact %s request while permitting discovery only on list', async sourceKind => {
  const result = full(sourceKind), unbound = { projectId: scope.projectId, analysisId: scope.analysisId, userId: 7 };
  expect(validateEvidenceIntakeList(list([item(sourceKind)]), unbound).serviceId).toBe(scope.serviceId);
  await expect(validateEvidenceIntake(result, unbound)).rejects.toMatchObject(invalid);
});
it.each(['local', 'server'])('validates exact %s admission and original accepted attachment without mutating the supplied reply', async sourceKind => {
  for (const result of [full(sourceKind), complete(sourceKind), complete(sourceKind, 'correct')]) {
    const before = JSON.stringify(result), value = await validateEvidenceIntake(result, scope, { sourceKind, recipe: result.recipe });
    expect(JSON.stringify(result)).toBe(before); expect(value).toEqual(result); expect(value).not.toBe(result); expect(value.recipe).not.toBe(result.recipe);
    if (value.attachmentOutcome.receipt) expect(value.attachmentOutcome.receipt).not.toBe(result.attachmentOutcome.receipt);
  }
});
it.each(['pending', 'failed', 'legacy-unrecorded'])('preserves the real server %s outcome without fabricating an accepted file', async status => {
  const result = full(); result.importOutcome = { status, receipt: serverReceipt(result.recipe, status) };
  const value = await validateEvidenceIntake(result, scope);
  expect(value).toEqual(result); expect(value.importOutcome.receipt.acceptance).toBeNull(); expect(value.attachmentOutcome.receipt).toBeNull();
});
it('keeps root-grant permission separate from attaching an already accepted owned snapshot', async () => {
  const result = complete(); result.canStartImport = false;
  const value = await validateEvidenceIntake(result, scope);
  expect(value.canContinue).toBe(true); expect(value.canAttach).toBe(true); expect(value.canStartImport).toBe(false);
  expect(value.importOutcome.receipt.canImport).toBe(true);
  const page = list(); page.items[0].canStartImport = false;
  expect(validateEvidenceIntakeList(page, scope).items[0].canStartImport).toBe(false);
});
it('validates a server PNG receipt through the same exact file and attachment identity contract', async () => {
  const result = full(); result.recipe.importRequest.relativePath = 'study/figure.PNG'; result.recipe.importRequest.name = 'Outside figure';
  result.recipe.attachment.caption = 'Completed figure'; rehash(result);
  const copied = serverReceipt(result.recipe); copied.source.name = 'figure.PNG';
  copied.version.type = 'image'; copied.version.format = { id: 'org.w3.png', version: '1' }; copied.version.previews = ['image'];
  result.importOutcome = { status: 'accepted', receipt: copied };
  result.attachmentOutcome = { status: 'accepted', receipt: attached(result, copied.acceptance) };
  const value = await validateEvidenceIntake(result, scope);
  expect(value.importOutcome.receipt.version.type).toBe('image');
  expect(value.attachmentOutcome.receipt.acceptedRevision.reference).toEqual({ kind: 'artifact-version', versionId, sha256: fileSha });
});
it('retains exact accepted identity when the saved source is unavailable or the analysis has become read-only', async () => {
  const result = complete('server', 'correct'); result.canContinue = false; result.canAttach = false; result.canStartImport = false;
  result.importOutcome.receipt.availability = 'unavailable'; result.importOutcome.receipt.version = null;
  result.attachmentOutcome.receipt.canWrite = false; result.attachmentOutcome.receipt.acceptedSourceAccess = 'unavailable'; result.attachmentOutcome.receipt.attachment.sourceAccess = 'unavailable';
  const value = await validateEvidenceIntake(result, { ...scope, userId: '7' });
  expect(value.importOutcome.receipt.acceptance).toEqual(acceptance()); expect(value.importOutcome.receipt.version).toBeNull();
  expect(value.canAttach).toBe(false); expect(value.importOutcome.receipt.canImport).toBe(true);
});
it.each(['create', 'correct'])('keeps original %s acceptance separate from a newer current head and its private source', async action => {
  const result = complete('server', action), receipt = result.attachmentOutcome.receipt, original = structuredClone(receipt.acceptedRevision);
  receipt.attachment.headRevisionId = laterRevisionId;
  receipt.attachment.revision = { ...structuredClone(original), id: laterRevisionId, revisionNumber: original.revisionNumber + 1,
    previousRevisionId: original.id, caption: 'Newer interpretation', createdByUserId: 8,
    reference: { kind: 'artifact-version', versionId: 'av_' + '9'.repeat(24), sha256: '9'.repeat(64) }, createdAt: '2026-10-22T12:00:03.000Z' };
  receipt.attachment.sourceAccess = 'restricted';
  const value = await validateEvidenceIntake(result, scope);
  expect(value.attachmentOutcome.receipt.acceptedRevision).toEqual(original);
  expect(value.attachmentOutcome.receipt.attachment.headRevisionId).toBe(laterRevisionId);
  expect(value.attachmentOutcome.receipt.acceptedRevision.reference.versionId).toBe(versionId);
});
it('accepts the existing server filename segment bound while keeping local filename limits unchanged', () => {
  const result = list(); result.items[0].originalFilename = 's'.repeat(200) + '.csv';
  expect(validateEvidenceIntakeList(result, scope).items[0].originalFilename).toHaveLength(204);
  result.items[0].sourceKind = 'local'; expect(() => validateEvidenceIntakeList(result, scope)).toThrow(expect.objectContaining(invalid));
});
it('validates a full mixed 30-row newest-first page with explicit UUID tie order and an opaque cursor', () => {
  const result = list(Array.from({ length: 30 }, (_, index) => ({ ...item(index % 2 ? 'local' : 'server'),
    requestId: `${(30 - index).toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, canStartImport: index % 2 === 1 })));
  result.nextCursor = 'eyJwYWdlIjoxfQ'; expect(validateEvidenceIntakeList(result, scope)).toEqual(result);
});
it.each([
  ['wrong owner', value => { value.ownerUserId = 8; }], ['string owner', value => { value.ownerUserId = '7'; }],
  ['wrong project', value => { value.projectId = 'proj_' + '9'.repeat(24); }], ['wrong analysis', value => { value.analysisId = 'ra_' + '9'.repeat(24); }],
  ['wrong service', value => { value.serviceId = 'svc_' + '9'.repeat(32); }], ['malformed service', value => { value.serviceId = 'server'; }],
  ['missing general authority', value => { delete value.canContinue; }], ['string general authority', value => { value.canContinue = 'true'; }],
  ['unequal analysis authority', value => { value.canAttach = false; }], ['unknown envelope field', value => { value.storageKey = 'private'; }],
  ['old source-specific envelope', value => { value.canUpload = true; }], ['unknown source kind', value => { value.items[0].sourceKind = 'remote'; }],
  ['missing source kind', value => { delete value.items[0].sourceKind; }], ['missing copy capability', value => { delete value.items[0].canStartImport; }],
  ['string copy capability', value => { value.items[0].canStartImport = 'false'; }],
  ['copy capability with no write authority', value => { value.canContinue = false; value.canAttach = false; }],
  ['local capability divergence', value => { value.items[0].sourceKind = 'local'; value.items[0].canStartImport = false; }],
  ['unknown summary field', value => { value.items[0].absolutePath = '/data/scores.csv'; }],
  ['wrong UUID', value => { value.items[0].requestId = 'request'; }], ['uppercase UUID', value => { value.items[0].requestId = requestId.toUpperCase(); }],
  ['bad checksum', value => { value.items[0].requestSha256 = 'A'.repeat(64); }],
  ['unknown import state', value => { value.items[0].importStatus = 'missing'; }],
  ['unproved accepted attachment', value => { value.items[0].attachmentStatus = 'accepted'; }],
  ['local pending state', value => { value.items[0].sourceKind = 'local'; value.items[0].importStatus = 'pending'; }],
  ['unsafe original path', value => { value.items[0].originalFilename = '../scores.csv'; }], ['backslash filename', value => { value.items[0].originalFilename = 'study\\scores.csv'; }],
  ['hidden original file', value => { value.items[0].originalFilename = '.scores.csv'; }], ['unsupported file', value => { value.items[0].originalFilename = 'scores.rds'; }],
  ['oversized original file', value => { value.items[0].originalFilename = 's'.repeat(240) + '.csv'; }],
  ['unnormalized name', value => { value.items[0].name = ' Outside scores '; }], ['oversized name', value => { value.items[0].name = 'x'.repeat(161); }],
  ['unnormalized caption', value => { value.items[0].caption = ' Outside scores '; }], ['hidden caption control', value => { value.items[0].caption = 'x\0y'; }],
  ['oversized caption', value => { value.items[0].caption = 'x'.repeat(2001); }], ['bad date', value => { value.items[0].createdAt = '2026-02-30T12:00:00.000Z'; }],
  ['invalid action', value => { value.items[0].action = 'replace'; }], ['create with head target', value => { value.items[0].expectedHeadRevisionId = firstRevisionId; }],
  ['correction without exact head', value => { value.items[0].action = 'correct'; value.items[0].attachmentId = attachmentId; }],
  ['excessive page', value => { value.items = Array(31).fill(item()); }], ['duplicate across sources', value => { value.items.push(item('local')); }],
  ['chronological reverse', value => { value.items.push({ ...item('local'), requestId: '00000000-0000-4000-8000-000000000001', createdAt: '2026-10-22T12:00:01.000Z' }); }],
  ['UUID reverse at same time', value => { value.items.push({ ...item('local'), requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }); }],
  ['missing cursor', value => { delete value.nextCursor; }], ['oversized cursor', value => { value.nextCursor = 'a'.repeat(257); }],
  ['nonopaque cursor', value => { value.nextCursor = '/data/private'; }], ['empty continuing page', value => { value.items = []; value.nextCursor = 'next'; }],
])('rejects mixed discovery with %s', (_description, mutate) => {
  const result = list(); mutate(result); expect(() => validateEvidenceIntakeList(result, scope)).toThrow(expect.objectContaining(invalid));
});
it.each([
  ['another recipe service', value => { value.recipe.serviceId = 'svc_' + '9'.repeat(32); rehash(value); }],
  ['another recipe project', value => { value.recipe.projectId = 'proj_' + '9'.repeat(24); rehash(value); }],
  ['another recipe owner', value => { value.recipe.ownerUserId = 8; rehash(value); }],
  ['another exact UUID', value => { value.requestId = attachmentRequestId; }], ['wrong recipe hash', value => { value.requestSha256 = '0'.repeat(64); }],
  ['altered immutable meaning', value => { value.recipe.attachment.caption = 'Changed'; }], ['unnormalized recipe', value => { value.recipe.importRequest.name = ' Outside scores '; }],
  ['extra recipe field', value => { value.recipe.sha256 = fileSha; }], ['copy authority without analysis write', value => { value.canContinue = false; value.canAttach = false; }],
  ['invalid source kind', value => { value.sourceKind = 'ssh'; }], ['old upload key', value => { value.canUpload = true; }],
  ['missing replay flag', value => { delete value.replayed; }], ['string replay flag', value => { value.replayed = 'false'; }],
  ['unknown outcome field', value => { value.importOutcome.error = 'untrusted'; }], ['null accepted receipt', value => { value.importOutcome.receipt = null; }],
  ['receipt on unknown outcome', value => { value.importOutcome.status = 'unconfirmed'; }], ['unrecognized copy outcome', value => { value.importOutcome.status = 'complete'; }],
  ['pending outcome with accepted receipt', value => { value.importOutcome.status = 'pending'; }], ['failed outcome with accepted receipt', value => { value.importOutcome.status = 'failed'; }],
  ['legacy outcome with accepted receipt', value => { value.importOutcome.status = 'legacy-unrecorded'; }],
  ['copy request from another owner', value => { value.importOutcome.receipt.ownerUserId = 8; }],
  ['copy request from another server', value => { value.importOutcome.receipt.serviceId = 'svc_' + '9'.repeat(32); }],
  ['another original copy body', value => { value.importOutcome.receipt.request.selectionToken = 'e'.repeat(64); }],
  ['another copy hash', value => { value.importOutcome.receipt.requestSha256 = '0'.repeat(64); }],
  ['size mismatches frozen selection', value => { value.recipe.selectionSizeBytes = 15; rehash(value); }],
  ['another accepted SHA', value => { value.importOutcome.receipt.acceptance.sha256 = 'e'.repeat(64); }],
  ['another available version', value => { value.importOutcome.receipt.version.versionId = 'av_' + '9'.repeat(24); }],
  ['unavailable receipt retaining version', value => { value.importOutcome.receipt.availability = 'unavailable'; }],
  ['legacy accepted as final SHA', value => { value.importOutcome.receipt = serverReceipt(value.recipe, 'legacy-unrecorded'); }],
  ['pending proof of attachment', value => { value.importOutcome = { status: 'pending', receipt: serverReceipt(value.recipe, 'pending') }; }],
  ['unknown attachment state', value => { value.attachmentOutcome.status = 'done'; }], ['attachment null on accepted', value => { value.attachmentOutcome.receipt = null; }],
  ['another attachment actor', value => { value.attachmentOutcome.receipt.acceptedRevision.createdByUserId = 8; }],
  ['another attachment request', value => { value.attachmentOutcome.receipt.requestId = requestId; }],
  ['another attachment caption', value => { value.attachmentOutcome.receipt.acceptedRevision.caption = 'Changed'; }],
  ['another attachment source', value => { value.attachmentOutcome.receipt.acceptedRevision.reference.versionId = 'av_' + '9'.repeat(24); }],
  ['unmatched attachment authority', value => { value.attachmentOutcome.receipt.canWrite = false; }],
  ['restricted original owner source', value => { value.attachmentOutcome.receipt.acceptedSourceAccess = 'restricted'; }],
  ['unknown nested receipt field', value => { value.attachmentOutcome.receipt.privatePath = '/private'; }],
  ['unknown revision field', value => { value.attachmentOutcome.receipt.acceptedRevision.fileBytes = [1, 2]; }],
  ['forged current head lineage', value => { value.attachmentOutcome.receipt.attachment.revision.previousRevisionId = firstRevisionId; }],
  ['malformed recorded date', value => { value.createdAt = '2026-02-30T12:00:00.000Z'; }],
])('rejects exact server recovery with %s', async (_description, mutate) => {
  const result = complete(); mutate(result); await expect(validateEvidenceIntake(result, scope)).rejects.toMatchObject(invalid);
});
it.each(['pending', 'failed', 'legacy-unrecorded'])('rejects server %s receipts whose actual reservation differs from the frozen selection', async status => {
  const result = full(); result.importOutcome = { status, receipt: serverReceipt(result.recipe, status) };
  result.recipe.selectionSizeBytes = 15; rehash(result); await expect(validateEvidenceIntake(result, scope)).rejects.toMatchObject(invalid);
});
it('binds the supplied original kind and canonical intent instead of accepting a different recovered record', async () => {
  const result = complete();
  await expect(validateEvidenceIntake(result, scope, { sourceKind: 'local', recipe: recipe('local') })).rejects.toMatchObject(invalid);
  const changed = structuredClone(result.recipe); changed.attachment.caption = 'Different caption';
  await expect(validateEvidenceIntake(result, scope, { sourceKind: 'server', recipe: changed })).rejects.toMatchObject(invalid);
  await expect(validateEvidenceIntake(result, scope, { sourceKind: 'server', recipe: result.recipe, latest: true })).rejects.toMatchObject(invalid);
  const local = full('local'), localChanged = structuredClone(local.recipe); localChanged.importRequest.sha256 = 'e'.repeat(64);
  await expect(validateEvidenceIntake(local, scope, { sourceKind: 'local', recipe: localChanged })).rejects.toMatchObject(invalid);
});
it('rejects unknown, inherited, getter, symbol, hidden, sparse, cyclic and non-JSON data before invoking computed fields', async () => {
  let read = false;
  const getter = complete(); Object.defineProperty(getter, 'recipe', { enumerable: true, get() { read = true; return recipe(); } });
  const nested = complete(); Object.defineProperty(nested.importOutcome.receipt.acceptance, 'sha256', { enumerable: true, get() { read = true; return fileSha; } });
  const hidden = complete(); Object.defineProperty(hidden, 'canAttach', { value: true, enumerable: false });
  const symbol = { ...complete(), [Symbol('source')]: 'private' };
  const cyclic = complete(); cyclic.recipe.attachment.suppliedOrigin.origin = cyclic;
  for (const result of [getter, nested, hidden, symbol, cyclic, Object.assign(Object.create({ inherited: true }), complete()),
    null, [], 'receipt', { ...full(), createdAt: '\ud800' }, { ...full(), serverFunction: () => {} }]) await expect(validateEvidenceIntake(result, scope)).rejects.toMatchObject(invalid);
  const sparse = list(new Array(1)), arrayGetter = list();
  Object.defineProperty(arrayGetter.items, 0, { enumerable: true, get() { read = true; return item(); } });
  for (const value of [sparse, arrayGetter, { ...list(), items: Object.assign([item()], { secret: 'extra' }) }]) expect(() => validateEvidenceIntakeList(value, scope)).toThrow(expect.objectContaining(invalid));
  const scopeGetter = { ...scope }; Object.defineProperty(scopeGetter, 'serviceId', { enumerable: true, get() { read = true; return scope.serviceId; } });
  await expect(validateEvidenceIntake(full(), scopeGetter)).rejects.toMatchObject(invalid);
  const expectedGetter = { sourceKind: 'server' }; Object.defineProperty(expectedGetter, 'recipe', { enumerable: true, get() { read = true; return recipe(); } });
  await expect(validateEvidenceIntake(full(), scope, expectedGetter)).rejects.toMatchObject(invalid);
  expect(read).toBe(false);
});
it.each(['local', 'server'])('captures the %s reply, scope and original intent before asynchronous digest work can race caller mutation', async sourceKind => {
  const input = complete(sourceKind), mutableScope = { ...scope }, original = { sourceKind, recipe: structuredClone(input.recipe) };
  let release, first = true;
  vi.stubGlobal('crypto', { subtle: { digest: (algorithm, bytes) => {
    if (!first) return webcrypto.subtle.digest(algorithm, bytes);
    first = false; return new Promise(resolve => { release = () => resolve(webcrypto.subtle.digest(algorithm, bytes)); });
  } } });
  const pending = validateEvidenceIntake(input, mutableScope, original);
  expect(release).toEqual(expect.any(Function));
  mutableScope.userId = 8; mutableScope.projectId = 'proj_' + '9'.repeat(24);
  original.sourceKind = sourceKind === 'server' ? 'local' : 'server'; original.recipe.attachment.caption = 'Changed expected interpretation';
  input.recipe.attachment.caption = 'Changed response interpretation'; input.importOutcome.receipt.acceptance.sha256 = 'e'.repeat(64);
  input.attachmentOutcome.receipt.acceptedRevision.caption = 'Changed accepted interpretation';
  release(); const value = await pending;
  expect(value.ownerUserId).toBe(7); expect(value.projectId).toBe(scope.projectId); expect(value.sourceKind).toBe(sourceKind);
  expect(value.recipe.attachment.caption).toBe('Outside treatment scores'); expect(value.importOutcome.receipt.acceptance.sha256).toBe(fileSha);
  expect(value.attachmentOutcome.receipt.acceptedRevision.caption).toBe('Outside treatment scores');
});
it.each([
  { ...scope, userId: '07' }, { ...scope, userId: 0 }, { ...scope, userId: Number.MAX_SAFE_INTEGER + 1 },
  { ...scope, projectId: 'project' }, { ...scope, analysisId: 'analysis' }, { ...scope, serviceId: 'svc_' + 'A'.repeat(32) },
  { ...scope, serviceId: scope.serviceId, unknown: true },
])('rejects malformed scope %j', async badScope => {
  expect(() => validateEvidenceIntakeList(list(), badScope)).toThrow(expect.objectContaining(invalid));
  await expect(validateEvidenceIntake(full(), badScope)).rejects.toMatchObject(invalid);
});
