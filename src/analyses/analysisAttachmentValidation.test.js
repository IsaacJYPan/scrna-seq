import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalAnalysisAttachmentContent, canonicalAnalysisAttachmentCorrection, normalizeAnalysisAttachmentCreate } from '../../shared/analysisAttachment.mjs';
import { validateAttachmentAcceptance, validateAttachmentCorrectionAcceptance, validateAttachmentHistory, validateAttachmentList,
  validateAttachmentOptions, validateAttachmentRevision } from './analysisAttachmentValidation';

const scope = { projectId: `proj_${'1'.repeat(24)}`, analysisId: `ra_${'2'.repeat(24)}`, userId: 1 };
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const attachmentId = `raa_${'3'.repeat(24)}`;
const revisionId = `rar_${'4'.repeat(24)}`;
const reference = { kind: 'artifact-version', versionId: `av_${'5'.repeat(24)}`, sha256: 'a'.repeat(64) };
const suppliedOrigin = { origin: null, sourceReference: null, documentReference: null, environmentReference: null };
const input = { requestId, reference, caption: 'Treatment response scores', suppliedOrigin };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const revision = (changes = {}) => ({ id: revisionId, attachmentId, revisionNumber: 1, reference: { ...reference }, caption: input.caption,
  suppliedOrigin: { ...suppliedOrigin }, createdByUserId: 1, createdAt: '2026-10-20T12:00:00.000Z', ...changes });
const attachment = (changes = {}) => ({ id: attachmentId, headRevisionId: revisionId, revision: revision(), sourceAccess: 'available', ...changes });
const common = { projectId: scope.projectId, analysisId: scope.analysisId, canWrite: true };
const list = () => ({ ...common, attachments: [attachment()], nextCursor: null });
const options = () => ({ ...common, items: [{ reference: { ...reference }, name: 'scores.csv', format: { id: 'org.ietf.csv', version: '1' },
  sizeBytes: 14, createdAt: '2026-10-20T12:00:00Z' }], nextCursor: null });
const acceptance = () => ({ ...common, requestId, requestSha256: sha256(canonicalAnalysisAttachmentContent(input)), replayed: false,
  acceptedRevision: revision(), attachment: attachment() });
const invalid = { code: 'INVALID_ANALYSIS_ATTACHMENT_RESPONSE' };

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

it('accepts scoped immutable attachment rows and preserves restricted or unavailable source access without widening it', () => {
  for (const sourceAccess of ['available', 'restricted', 'unavailable']) {
    const result = list(); result.canWrite = false; result.attachments[0].sourceAccess = sourceAccess;
    result.attachments[0].privateStorageKey = 'private/source.csv';
    const value = validateAttachmentList(result, scope);
    expect(value.canWrite).toBe(false); expect(value.attachments[0].sourceAccess).toBe(sourceAccess);
    expect(value.attachments[0]).not.toHaveProperty('privateStorageKey');
    expect(value).not.toBe(result); expect(value.attachments[0].revision.reference).not.toBe(result.attachments[0].revision.reference);
    expect(result.attachments[0].privateStorageKey).toBe('private/source.csv');
  }
});

it('accepts newer current head revisions and reordered JSON keys without changing exact source identity', () => {
  const result = list();
  result.attachments[0].revision.revisionNumber = 4;
  result.attachments[0].revision.reference = Object.fromEntries(Object.entries(reference).reverse());
  result.attachments[0].revision.suppliedOrigin = Object.fromEntries(Object.entries(suppliedOrigin).reverse());
  expect(validateAttachmentList(result, scope).attachments[0].revision).toMatchObject({ revisionNumber: 4, reference, suppliedOrigin });
});

it.each([
  ['wrong project', value => { value.projectId = 'another-project'; }],
  ['wrong analysis', value => { value.analysisId = `ra_${'9'.repeat(24)}`; }],
  ['missing authority', value => { delete value.canWrite; }],
  ['nonboolean authority', value => { value.canWrite = 'true'; }],
  ['missing page cursor', value => { delete value.nextCursor; }],
  ['oversized cursor', value => { value.nextCursor = 'a'.repeat(257); }],
  ['invalid cursor', value => { value.nextCursor = '/private/path'; }],
  ['duplicate stable attachments', value => { value.attachments.push(structuredClone(value.attachments[0])); }],
  ['oversized page', value => { value.attachments = Array.from({ length: 31 }, () => value.attachments[0]); }],
  ['wrong stable ID', value => { value.attachments[0].id = `raa_${'9'.repeat(24)}`; }],
  ['coerced stable ID', value => { value.attachments[0].id = [attachmentId]; }],
  ['wrong head revision', value => { value.attachments[0].headRevisionId = `rar_${'9'.repeat(24)}`; }],
  ['mutable reference', value => { value.attachments[0].revision.reference.versionId = 'latest'; }],
  ['nonmanaged reference', value => { value.attachments[0].revision.reference.versionId = `eri_${'5'.repeat(24)}`; }],
  ['invalid reference hash', value => { value.attachments[0].revision.reference.sha256 = 'A'.repeat(64); }],
  ['missing unknown-origin marker', value => { delete value.attachments[0].revision.suppliedOrigin.sourceReference; }],
  ['unverified execution claim', value => { value.attachments[0].revision.suppliedOrigin.executed = true; }],
  ['empty caption', value => { value.attachments[0].revision.caption = ''; }],
  ['unnormalized caption', value => { value.attachments[0].revision.caption = '  Scores  '; }],
  ['oversized caption', value => { value.attachments[0].revision.caption = 'x'.repeat(2001); }],
  ['invalid revision number', value => { value.attachments[0].revision.revisionNumber = 0; }],
  ['coerced actor', value => { value.attachments[0].revision.createdByUserId = '1'; }],
  ['invalid time', value => { value.attachments[0].revision.createdAt = 'yesterday'; }],
  ['unknown source access', value => { value.attachments[0].sourceAccess = 'verified'; }],
])('rejects a list with %s', (_label, mutate) => {
  const result = list(); mutate(result);
  expect(() => validateAttachmentList(result, scope)).toThrow(expect.objectContaining(invalid));
});

it('rejects non-JSON response records without evaluating accessors', () => {
  const getter = vi.fn(() => true);
  const result = Object.defineProperty(list(), 'canWrite', { enumerable: true, get: getter });
  expect(() => validateAttachmentList(result, scope)).toThrow(expect.objectContaining(invalid));
  expect(getter).not.toHaveBeenCalled();
  expect(() => validateAttachmentList(Object.create(list()), scope)).toThrow(expect.objectContaining(invalid));
});

it.each(['org.ietf.csv', 'org.iana.tsv', 'org.w3.png', 'org.iso.jpeg'])('accepts a bounded exact %s option without copying source bytes', formatId => {
  const result = options(); result.items[0].format.id = formatId; result.items[0].bytes = [1, 2, 3];
  const value = validateAttachmentOptions(result, scope);
  expect(value.items[0]).toMatchObject({ reference, format: { id: formatId, version: '1' } });
  expect(value.items[0]).not.toHaveProperty('bytes');
});

it.each([
  ['unsupported object format', value => { value.items[0].format.id = 'org.r-project.rds'; }],
  ['wrong format version', value => { value.items[0].format.version = '2'; }],
  ['nonmanaged version', value => { value.items[0].reference.versionId = `art_${'5'.repeat(24)}`; }],
  ['coerced reference', value => { value.items[0].reference.versionId = [reference.versionId]; }],
  ['source path in reference', value => { value.items[0].reference.path = '/private/scores.csv'; }],
  ['oversized name', value => { value.items[0].name = 'α'.repeat(161); }],
  ['control in name', value => { value.items[0].name = 'scores\n.csv'; }],
  ['fractional size', value => { value.items[0].sizeBytes = 1.5; }],
  ['oversized file', value => { value.items[0].sizeBytes = 200 * 1024 * 1024 + 1; }],
  ['duplicate versions', value => { value.items.push(structuredClone(value.items[0])); }],
  ['oversized page', value => { value.items = Array(31).fill(value.items[0]); }],
  ['wrong scope', value => { value.analysisId = `ra_${'9'.repeat(24)}`; }],
])('rejects an option page with %s', (_label, mutate) => {
  const result = options(); mutate(result);
  expect(() => validateAttachmentOptions(result, scope)).toThrow(expect.objectContaining(invalid));
});

it('binds acceptance to normalized request content and current reader authority without treating supplied origin as execution evidence', async () => {
  const draft = { ...input, requestId: requestId.toUpperCase(), caption: '  Treatment response scores\r\nImported externally.  ',
    suppliedOrigin: { origin: '  External lab  ', sourceReference: '', documentReference: '  Methods supplement  ', environmentReference: null } };
  const normalized = normalizeAnalysisAttachmentCreate(draft);
  const result = acceptance(); result.canWrite = false; result.replayed = true;
  result.requestSha256 = sha256(canonicalAnalysisAttachmentContent(normalized));
  result.acceptedRevision = revision({ caption: normalized.caption, suppliedOrigin: normalized.suppliedOrigin });
  result.attachment = attachment({ revision: structuredClone(result.acceptedRevision), sourceAccess: 'restricted' });
  await expect(validateAttachmentAcceptance(result, scope, draft)).resolves.toMatchObject({ canWrite: false, replayed: true,
    acceptedRevision: { reference, caption: normalized.caption, suppliedOrigin: normalized.suppliedOrigin }, attachment: { sourceAccess: 'restricted' } });
});

it('keeps the accepted first revision separate from a newer current head', async () => {
  const result = acceptance(); result.replayed = true;
  const newerId = `rar_${'6'.repeat(24)}`;
  result.attachment = attachment({ headRevisionId: newerId, sourceAccess: 'unavailable', revision: revision({ id: newerId, revisionNumber: 3,
    caption: 'A later corrected caption', reference: { ...reference, versionId: `av_${'7'.repeat(24)}` }, createdByUserId: 2 }) });
  const value = await validateAttachmentAcceptance(result, scope, input);
  expect(value.acceptedRevision.id).toBe(revisionId); expect(value.acceptedRevision.caption).toBe(input.caption);
  expect(value.attachment.revision.revisionNumber).toBe(3); expect(value.attachment.revision.caption).toBe('A later corrected caption');
  expect(value.attachment.sourceAccess).toBe('unavailable');
});

it.each([
  ['wrong project', value => { value.projectId = 'another-project'; }],
  ['wrong analysis', value => { value.analysisId = `ra_${'9'.repeat(24)}`; }],
  ['wrong request', value => { value.requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; }],
  ['wrong fingerprint', value => { value.requestSha256 = '0'.repeat(64); }],
  ['missing replay state', value => { delete value.replayed; }],
  ['coerced authority', value => { value.canWrite = 'false'; }],
  ['wrong accepted actor', value => { value.acceptedRevision.createdByUserId = 2; }],
  ['later accepted revision', value => { value.acceptedRevision.revisionNumber = 2; }],
  ['changed accepted source', value => { value.acceptedRevision.reference.sha256 = 'b'.repeat(64); }],
  ['changed accepted caption', value => { value.acceptedRevision.caption = 'Different caption'; }],
  ['changed supplied origin', value => { value.acceptedRevision.suppliedOrigin.origin = 'Another origin'; }],
  ['unrelated current attachment', value => {
    value.attachment.id = `raa_${'9'.repeat(24)}`; value.attachment.revision.attachmentId = value.attachment.id;
  }],
  ['same revision changed in place', value => { value.attachment.revision.caption = 'Changed in place'; }],
  ['different first current revision', value => {
    value.attachment.headRevisionId = `rar_${'9'.repeat(24)}`; value.attachment.revision.id = value.attachment.headRevisionId;
  }],
  ['same revision ID with newer number', value => { value.attachment.revision.revisionNumber = 2; }],
])('keeps the request unconfirmed for acceptance with %s', async (_label, mutate) => {
  const result = acceptance(); mutate(result);
  await expect(validateAttachmentAcceptance(result, scope, input)).rejects.toMatchObject(invalid);
});

it('does not accept a changed draft merely because the UUID is unchanged', async () => {
  await expect(validateAttachmentAcceptance(acceptance(), scope, { ...input, caption: 'Another draft' })).rejects.toMatchObject(invalid);
  await expect(validateAttachmentAcceptance(acceptance(), scope, { ...input, reference: { ...reference, versionId: `av_${'9'.repeat(24)}` } })).rejects.toMatchObject(invalid);
});

const secondRevisionId = `rar_${'6'.repeat(24)}`;
const thirdRevisionId = `rar_${'7'.repeat(24)}`;
const correctionInput = { ...input, expectedHeadRevisionId: revisionId, caption: 'Corrected treatment response',
  reference: { ...reference, versionId: `av_${'8'.repeat(24)}`, sha256: 'b'.repeat(64) } };
const firstRevision = () => revision({ previousRevisionId: null });
const secondRevision = changes => revision({ id: secondRevisionId, previousRevisionId: revisionId, revisionNumber: 2,
  reference: { ...correctionInput.reference }, caption: correctionInput.caption, ...changes });
const thirdRevision = changes => secondRevision({ id: thirdRevisionId, previousRevisionId: secondRevisionId, revisionNumber: 3,
  caption: 'A newer revision by a colleague', createdByUserId: 2, ...changes });
const corrected = () => ({ ...common, requestId, requestSha256: sha256(canonicalAnalysisAttachmentCorrection(attachmentId, correctionInput)),
  replayed: false, acceptedRevision: secondRevision(), acceptedSourceAccess: 'available',
  attachment: attachment({ headRevisionId: secondRevisionId, revision: secondRevision() }) });
const history = () => ({ ...common, attachmentId, headRevisionId: thirdRevisionId, revisions: [
  { revision: thirdRevision(), sourceAccess: 'available' }, { revision: secondRevision(), sourceAccess: 'restricted' },
  { revision: firstRevision(), sourceAccess: 'unavailable' },
], nextCursor: null });
const exactRevision = () => ({ ...common, attachmentId, headRevisionId: thirdRevisionId, revision: secondRevision(), sourceAccess: 'restricted' });

it('keeps create request bytes unchanged and includes action, target and frozen expected head in correction hashing', async () => {
  const expectedCreate = JSON.stringify({ reference, caption: input.caption, suppliedOrigin });
  expect(canonicalAnalysisAttachmentContent(input)).toBe(expectedCreate);
  const create = acceptance(); create.acceptedSourceAccess = 'restricted';
  await expect(validateAttachmentAcceptance(create, scope, input)).resolves.toMatchObject({ requestSha256: sha256(expectedCreate), acceptedSourceAccess: 'restricted' });
  const value = await validateAttachmentCorrectionAcceptance(corrected(), scope, attachmentId, correctionInput);
  expect(value.requestSha256).not.toBe(sha256(expectedCreate));
  expect(value.requestSha256).toBe(sha256(JSON.stringify({ action: 'correct', attachmentId, expectedHeadRevisionId: revisionId,
    reference: correctionInput.reference, caption: correctionInput.caption, suppliedOrigin })));
});

it('allows legacy create/list lineage omission while validating new optional accepted source access and lineage', async () => {
  await expect(validateAttachmentAcceptance(acceptance(), scope, input)).resolves.not.toHaveProperty('acceptedSourceAccess');
  const create = acceptance(); create.acceptedSourceAccess = false;
  await expect(validateAttachmentAcceptance(create, scope, input)).rejects.toMatchObject(invalid);
  create.acceptedSourceAccess = 'unavailable'; create.acceptedRevision.previousRevisionId = secondRevisionId;
  await expect(validateAttachmentAcceptance(create, scope, input)).rejects.toMatchObject(invalid);
  const result = list(); result.attachments.push(attachment({ id: `raa_${'9'.repeat(24)}`, headRevisionId: thirdRevisionId,
    revision: revision({ id: thirdRevisionId, attachmentId: `raa_${'9'.repeat(24)}` }) }));
  expect(validateAttachmentList(result, scope).attachments).toHaveLength(2);
});

it('recovers an older accepted correction under current reader authority without replacing its newer head or source access', async () => {
  const result = corrected(); result.canWrite = false; result.replayed = true; result.acceptedSourceAccess = 'restricted';
  result.attachment = attachment({ headRevisionId: thirdRevisionId, revision: thirdRevision(), sourceAccess: 'unavailable' });
  const value = await validateAttachmentCorrectionAcceptance(result, scope, attachmentId, correctionInput);
  expect(value).toMatchObject({ canWrite: false, replayed: true, acceptedSourceAccess: 'restricted',
    acceptedRevision: { id: secondRevisionId, previousRevisionId: revisionId, revisionNumber: 2 },
    attachment: { headRevisionId: thirdRevisionId, sourceAccess: 'unavailable', revision: { createdByUserId: 2 } } });
  expect(value.acceptedRevision.reference).toEqual(correctionInput.reference);
});

it('does not infer source ownership from the correcting actor', async () => {
  const result = corrected(); result.acceptedRevision.createdByUserId = 2; result.attachment.revision.createdByUserId = 2;
  result.acceptedSourceAccess = 'restricted'; result.attachment.sourceAccess = 'restricted';
  await expect(validateAttachmentCorrectionAcceptance(result, { ...scope, userId: 2 }, attachmentId, correctionInput))
    .resolves.toMatchObject({ acceptedSourceAccess: 'restricted', attachment: { sourceAccess: 'restricted' } });
  const read = exactRevision(); read.revision.createdByUserId = 2; read.sourceAccess = 'available';
  expect(validateAttachmentRevision(read, scope, attachmentId, secondRevisionId, correctionInput.reference).sourceAccess).toBe('available');
});

it.each([
  ['another attachment', value => { value.acceptedRevision.attachmentId = `raa_${'9'.repeat(24)}`; }],
  ['another request', value => { value.requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; }],
  ['create content hash', value => { value.requestSha256 = sha256(canonicalAnalysisAttachmentContent(input)); }],
  ['another correcting actor', value => { value.acceptedRevision.createdByUserId = 2; }],
  ['first revision acceptance', value => { value.acceptedRevision.revisionNumber = 1; value.acceptedRevision.previousRevisionId = null; }],
  ['missing predecessor', value => { delete value.acceptedRevision.previousRevisionId; }],
  ['different predecessor', value => { value.acceptedRevision.previousRevisionId = thirdRevisionId; }],
  ['accepted ID reused as predecessor', value => { value.acceptedRevision.previousRevisionId = secondRevisionId; }],
  ['missing accepted source access', value => { delete value.acceptedSourceAccess; }],
  ['invalid accepted source access', value => { value.acceptedSourceAccess = 'verified'; }],
  ['changed accepted source', value => { value.acceptedRevision.reference.sha256 = 'c'.repeat(64); }],
  ['changed accepted caption', value => { value.acceptedRevision.caption = 'Another correction'; }],
  ['older current head', value => { value.attachment = attachment({ revision: firstRevision() }); }],
  ['unrelated direct successor', value => {
    value.attachment = attachment({ headRevisionId: thirdRevisionId, revision: thirdRevision({ previousRevisionId: revisionId }) });
  }],
  ['wrong current attachment', value => { value.attachment.id = `raa_${'9'.repeat(24)}`; value.attachment.revision.attachmentId = value.attachment.id; }],
])('keeps a correction unconfirmed for %s', async (_label, mutate) => {
  const result = corrected(); mutate(result);
  await expect(validateAttachmentCorrectionAcceptance(result, scope, attachmentId, correctionInput)).rejects.toMatchObject(invalid);
});

it('binds correction recovery to the same frozen target, expected head and normalized content', async () => {
  await expect(validateAttachmentCorrectionAcceptance(corrected(), scope, `raa_${'9'.repeat(24)}`, correctionInput)).rejects.toMatchObject(invalid);
  await expect(validateAttachmentCorrectionAcceptance(corrected(), scope, attachmentId, { ...correctionInput, expectedHeadRevisionId: thirdRevisionId })).rejects.toMatchObject(invalid);
  await expect(validateAttachmentCorrectionAcceptance(corrected(), scope, attachmentId, { ...correctionInput, caption: 'Changed pending draft' })).rejects.toMatchObject(invalid);
});

it('returns ordered immutable history with independent per-revision source access and current head identity', () => {
  const result = history(); result.canWrite = false;
  result.revisions[0].sourcePath = '/private/source.csv';
  const value = validateAttachmentHistory(result, scope, attachmentId);
  expect(value.headRevisionId).toBe(thirdRevisionId); expect(value.canWrite).toBe(false);
  expect(value.revisions.map(item => item.revision.revisionNumber)).toEqual([3, 2, 1]);
  expect(value.revisions.map(item => item.sourceAccess)).toEqual(['available', 'restricted', 'unavailable']);
  expect(value.revisions[0]).not.toHaveProperty('sourcePath');
  expect(result.revisions[0]).toHaveProperty('sourcePath');
});

it('accepts an older history page while keeping the separately observed current head', () => {
  const result = history(); result.revisions.shift();
  const value = validateAttachmentHistory(result, scope, attachmentId);
  expect(value.headRevisionId).toBe(thirdRevisionId); expect(value.revisions[0].revision.id).toBe(secondRevisionId);
  result.revisions.pop(); result.nextCursor = 'older_page';
  expect(validateAttachmentHistory(result, scope, attachmentId).nextCursor).toBe('older_page');
});

it.each([
  ['wrong analysis', value => { value.analysisId = `ra_${'9'.repeat(24)}`; }],
  ['wrong collection target', value => { value.attachmentId = `raa_${'9'.repeat(24)}`; }],
  ['invalid head', value => { value.headRevisionId = 'latest'; }],
  ['head older than returned revisions', value => { value.headRevisionId = revisionId; }],
  ['wrong revision target', value => { value.revisions[0].revision.attachmentId = `raa_${'9'.repeat(24)}`; }],
  ['missing lineage', value => { delete value.revisions[0].revision.previousRevisionId; }],
  ['broken chain', value => { value.revisions[0].revision.previousRevisionId = revisionId; }],
  ['duplicate revisions', value => { value.revisions.push(structuredClone(value.revisions[0])); }],
  ['unordered revisions', value => { value.revisions.reverse(); }],
  ['gap in revision numbers', value => { value.revisions[0].revision.revisionNumber = 4; }],
  ['past the revision bound', value => { value.revisions[0].revision.revisionNumber = 201; }],
  ['source access widening', value => { value.revisions[1].sourceAccess = 'public'; }],
  ['oversized page', value => { value.revisions = Array(31).fill(value.revisions[0]); }],
  ['cursor after the first revision', value => { value.nextCursor = 'more'; }],
  ['truncated history without continuation', value => { value.revisions.pop(); }],
  ['invalid cursor', value => { value.revisions.pop(); value.nextCursor = '/private/cursor'; }],
])('rejects immutable history with %s', (_label, mutate) => {
  const result = history(); mutate(result);
  expect(() => validateAttachmentHistory(result, scope, attachmentId)).toThrow(expect.objectContaining(invalid));
});

it('binds an exact historical read to its attachment, revision and known source without substituting the current head', () => {
  const result = exactRevision(); result.canWrite = false;
  const value = validateAttachmentRevision(result, scope, attachmentId, secondRevisionId, correctionInput.reference);
  expect(value).toMatchObject({ headRevisionId: thirdRevisionId, canWrite: false, sourceAccess: 'restricted',
    revision: { id: secondRevisionId, attachmentId, previousRevisionId: revisionId, reference: correctionInput.reference } });
  expect(value.revision.id).not.toBe(value.headRevisionId);
  expect(validateAttachmentRevision(result, scope, attachmentId, secondRevisionId).revision.id).toBe(secondRevisionId);
});

it.each([
  ['wrong scope', value => { value.projectId = 'other-project'; }],
  ['wrong target', value => { value.attachmentId = `raa_${'9'.repeat(24)}`; }],
  ['wrong revision', value => { value.revision.id = thirdRevisionId; }],
  ['missing predecessor', value => { delete value.revision.previousRevisionId; }],
  ['current head older than selected revision', value => { value.headRevisionId = revisionId; }],
  ['changed source version', value => { value.revision.reference.versionId = reference.versionId; }],
  ['changed source hash', value => { value.revision.reference.sha256 = 'c'.repeat(64); }],
  ['wrong source access', value => { value.sourceAccess = true; }],
  ['history payload', value => { value.revisions = []; }],
  ['history cursor', value => { value.nextCursor = null; }],
])('rejects an exact revision response with %s', (_label, mutate) => {
  const result = exactRevision(); mutate(result);
  expect(() => validateAttachmentRevision(result, scope, attachmentId, secondRevisionId, correctionInput.reference)).toThrow(expect.objectContaining(invalid));
});
