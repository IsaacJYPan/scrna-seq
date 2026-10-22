import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ANALYSIS_SERVER_INTAKE_SCHEMA, ANALYSIS_SERVER_INTAKE_LIMITS, normalizeAnalysisServerIntake,
  canonicalAnalysisServerIntake, analysisServerIntakeAttachmentRequest } from '../shared/analysisServerIntake.mjs';
import { canonicalServerDataImportRequest } from '../shared/serverDataImport.mjs';
import { canonicalAnalysisLocalIntake } from '../shared/analysisLocalIntake.mjs';

const analysisId = 'ra_' + 'b'.repeat(24), projectId = 'proj_' + 'a'.repeat(24), serviceId = 'svc_' + 'c'.repeat(32);
const requestId = 'abcdefab-1234-4abc-8def-abcdefabcdef', attachmentRequestId = '00000000-0000-4000-8000-000000000002';
const sha = value => createHash('sha256').update(value).digest('hex');
const recipe = changes => ({ requestId, serviceId, projectId, ownerUserId: 7,
  importRequest: { requestId, rootId: 'study-a', relativePath: 'donor 1/β scores.csv', selectionToken: 'd'.repeat(64), name: '  β comparison  ' },
  selectionSizeBytes: 75, attachment: { requestId: attachmentRequestId, action: 'create', attachmentId: null, expectedHeadRevisionId: null,
    caption: '  β comparison\r\ncomplete  ', suppliedOrigin: {} }, ...changes });
const accepted = changes => ({ versionId: 'av_' + 'e'.repeat(24), sha256: 'f'.repeat(64), sizeBytes: 75, previousVersionId: null, ...changes });
const invalid = action => expect(action).toThrow(expect.objectContaining({ code: 'INVALID_ANALYSIS_SERVER_INTAKE', status: 400 }));
const literal = '{"schema":"traceomics.analysis-server-intake.v1","serviceId":"svc_cccccccccccccccccccccccccccccccc","projectId":"proj_aaaaaaaaaaaaaaaaaaaaaaaa","analysisId":"ra_bbbbbbbbbbbbbbbbbbbbbbbb","ownerUserId":7,"requestId":"abcdefab-1234-4abc-8def-abcdefabcdef","selectionSizeBytes":75,"importRequest":{"requestId":"abcdefab-1234-4abc-8def-abcdefabcdef","rootId":"study-a","relativePath":"donor 1/β scores.csv","selectionToken":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","name":"β comparison","artifactType":"auto","previousVersionId":null},"attachment":{"requestId":"00000000-0000-4000-8000-000000000002","action":"create","attachmentId":null,"expectedHeadRevisionId":null,"caption":"β comparison\\ncomplete","suppliedOrigin":{"origin":null,"sourceReference":null,"documentReference":null,"environmentReference":null}}}';

describe('source-free server evidence intake contract', () => {
  it('keeps bounded immutable metadata limits and a separate server schema', () => {
    expect(ANALYSIS_SERVER_INTAKE_SCHEMA).toBe('traceomics.analysis-server-intake.v1');
    expect(ANALYSIS_SERVER_INTAKE_LIMITS).toEqual({ recipes: 2000, page: 30, cursor: 256, canonicalBytes: 65536, fileBytes: 209715200 });
    expect(Object.isFrozen(ANALYSIS_SERVER_INTAKE_LIMITS)).toBe(true);
  });
  it('preserves the exact ordered literal including normalized source settings and attachment context', () => {
    const value = canonicalAnalysisServerIntake(analysisId, recipe());
    expect(value).toBe(literal);
    expect(sha(value)).toBe('c64bc0797b09d10948de4f77c865feb31e72c40f6be7bc0b77619a00d7dce9ae');
    expect(Object.keys(JSON.parse(value))).toEqual(['schema', 'serviceId', 'projectId', 'analysisId', 'ownerUserId', 'requestId', 'selectionSizeBytes', 'importRequest', 'attachment']);
  });
  it('keeps the original server request canonical unchanged, including defaults and the distinction of supplied empty annotations', () => {
    const input = recipe(), parsed = normalizeAnalysisServerIntake(input);
    expect(canonicalServerDataImportRequest(parsed.importRequest)).toBe(canonicalServerDataImportRequest(input.importRequest));
    expect(parsed.importRequest).toMatchObject({ name: 'β comparison', artifactType: 'auto', previousVersionId: null });
    expect(parsed.importRequest).not.toHaveProperty('sampleMetadata');
    const annotated = recipe({ importRequest: { ...input.importRequest, sampleMetadata: {} } });
    expect(normalizeAnalysisServerIntake(annotated).importRequest.sampleMetadata).toEqual({});
    expect(canonicalAnalysisServerIntake(analysisId, annotated)).not.toBe(canonicalAnalysisServerIntake(analysisId, input));
    expect(JSON.parse(canonicalAnalysisServerIntake(analysisId, input))).not.toHaveProperty('sha256');
    expect(parsed.importRequest).not.toHaveProperty('sha256');
  });
  it('normalizes both UUIDs and plain supplied origin without mutating a frozen caller recipe', () => {
    const input = recipe({ requestId: requestId.toUpperCase(), importRequest: { ...recipe().importRequest, requestId: requestId.toUpperCase(),
      sampleMetadata: { tissue: ' lung ', condition: ' treated ' } }, attachment: { ...recipe().attachment, suppliedOrigin: { sourceReference: '  script.R\r\nline 4  ' } } });
    Object.freeze(input.importRequest.sampleMetadata); Object.freeze(input.importRequest); Object.freeze(input.attachment.suppliedOrigin); Object.freeze(input.attachment); Object.freeze(input);
    const before = JSON.stringify(input), parsed = normalizeAnalysisServerIntake(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(parsed.requestId).toBe(requestId); expect(parsed.importRequest.requestId).toBe(requestId);
    expect(parsed.importRequest.sampleMetadata).toEqual({ condition: 'treated', tissue: 'lung' });
    expect(parsed.attachment.suppliedOrigin).toEqual({ origin: null, sourceReference: 'script.R\nline 4', documentReference: null, environmentReference: null });
    expect(normalizeAnalysisServerIntake(Object.assign(Object.create(null), input))).toEqual(parsed);
    expect(normalizeAnalysisServerIntake(recipe({ attachment: { ...recipe().attachment, requestId: 'BBBBBBBB-1234-4ABC-8DEF-ABCDEFABCDEF' } })).attachment.requestId).toBe('bbbbbbbb-1234-4abc-8def-abcdefabcdef');
  });
  it('binds server, project, owner, analysis, selection, source settings and interpretation independently', () => {
    const input = recipe(), original = canonicalAnalysisServerIntake(analysisId, input);
    const changes = [{ serviceId: 'svc_' + 'e'.repeat(32) }, { projectId: 'proj_' + 'e'.repeat(24) }, { ownerUserId: 8 }, { selectionSizeBytes: 76 },
      { importRequest: { ...input.importRequest, name: 'New saved name' } }, { importRequest: { ...input.importRequest, rootId: 'other-root' } },
      { importRequest: { ...input.importRequest, relativePath: 'donor 2/β scores.csv' } }, { importRequest: { ...input.importRequest, selectionToken: 'e'.repeat(64) } },
      { importRequest: { ...input.importRequest, sampleMetadata: { condition: 'control' } } },
      { attachment: { ...input.attachment, caption: 'Different scientific interpretation' } },
      { attachment: { ...input.attachment, suppliedOrigin: { origin: 'Outside report' } } },
      { attachment: { ...input.attachment, requestId: '00000000-0000-4000-8000-000000000003' } },
      { attachment: { ...input.attachment, action: 'correct', attachmentId: 'raa_' + 'e'.repeat(24), expectedHeadRevisionId: 'rar_' + 'f'.repeat(24) } },
      { requestId: '00000000-0000-4000-8000-000000000004', importRequest: { ...input.importRequest, requestId: '00000000-0000-4000-8000-000000000004' } }];
    for (const changed of changes) expect(canonicalAnalysisServerIntake(analysisId, { ...input, ...changed })).not.toBe(original);
    expect(canonicalAnalysisServerIntake('ra_' + 'e'.repeat(24), input)).not.toBe(original);
  });
  it.each(['csv', 'CSV', 'tsv', 'png', 'PNG', 'jpg', 'jpeg', 'JPEG'])('admits an ordinary %s result selection without claiming its bytes were verified', extension => {
    const input = recipe({ importRequest: { ...recipe().importRequest, relativePath: 'study/result.' + extension } });
    expect(normalizeAnalysisServerIntake(input).selectionSizeBytes).toBe(75);
  });
  it.each(['rds', 'json', 'txt', 'svg', 'zip', 'csv.exe', 'png.txt', ''])('rejects source format %s from this attachment intake without restricting the generic importer', extension => {
    invalid(() => normalizeAnalysisServerIntake(recipe({ importRequest: { ...recipe().importRequest, relativePath: 'result' + (extension ? '.' + extension : '') } })));
  });
  it.each([0, -1, 1.5, '75', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 209715201])('rejects invalid declared selection size %s', selectionSizeBytes => {
    invalid(() => normalizeAnalysisServerIntake(recipe({ selectionSizeBytes })));
  });
  it('accepts the exact size boundary while leaving actual source verification to admission and the copier', () => {
    for (const selectionSizeBytes of [1, ANALYSIS_SERVER_INTAKE_LIMITS.fileBytes]) {
      expect(normalizeAnalysisServerIntake(recipe({ selectionSizeBytes })).selectionSizeBytes).toBe(selectionSizeBytes);
    }
  });
  it('requires a new automatic source import and a distinct valid attachment request', () => {
    const input = recipe();
    for (const change of [{ artifactType: 'sample-sheet' }, { previousVersionId: 'av_' + 'e'.repeat(24) }, { requestId: attachmentRequestId }]) {
      invalid(() => normalizeAnalysisServerIntake(recipe({ importRequest: { ...input.importRequest, ...change } })));
    }
    invalid(() => normalizeAnalysisServerIntake(recipe({ attachment: { ...input.attachment, requestId } })));
    invalid(() => normalizeAnalysisServerIntake(recipe({ attachment: { ...input.attachment, requestId: requestId.toUpperCase() } })));
    for (const badId of ['request', null, 1, ['00000000-0000-4000-8000-000000000001'], '00000000-0000-0000-0000-000000000001']) {
      invalid(() => normalizeAnalysisServerIntake(recipe({ requestId: badId })));
      invalid(() => normalizeAnalysisServerIntake(recipe({ attachment: { ...input.attachment, requestId: badId } })));
    }
  });
  it('requires exact create/correction intent and retains its expected revision in the accepted attachment', () => {
    const input = recipe(), correction = { ...input.attachment, action: 'correct', attachmentId: 'raa_' + 'a'.repeat(24), expectedHeadRevisionId: 'rar_' + 'b'.repeat(24) };
    for (const attachment of [{ ...input.attachment, action: 'replace' }, { ...input.attachment, attachmentId: correction.attachmentId },
      { ...input.attachment, expectedHeadRevisionId: correction.expectedHeadRevisionId }, { ...correction, attachmentId: null },
      { ...correction, expectedHeadRevisionId: null }, { ...correction, expectedHeadRevisionId: 'rar_' + 'B'.repeat(24) }]) invalid(() => normalizeAnalysisServerIntake(recipe({ attachment })));
    const created = analysisServerIntakeAttachmentRequest(input, accepted());
    expect(created).toEqual({ requestId: attachmentRequestId, reference: { kind: 'artifact-version', versionId: accepted().versionId, sha256: accepted().sha256 },
      caption: 'β comparison\ncomplete', suppliedOrigin: { origin: null, sourceReference: null, documentReference: null, environmentReference: null } });
    const corrected = analysisServerIntakeAttachmentRequest(recipe({ attachment: correction }), accepted());
    expect(corrected).toEqual({ ...created, expectedHeadRevisionId: correction.expectedHeadRevisionId });
    expect(corrected).not.toHaveProperty('attachmentId');
  });
  it('derives file identity only from exact accepted version/SHA/size, with no filename or latest-version inference', () => {
    for (const changes of [{ versionId: 'av_' + 'e'.repeat(23) }, { versionId: 'art_' + 'e'.repeat(24) }, { versionId: ['av_' + 'e'.repeat(24)] },
      { sha256: 'F'.repeat(64) }, { sha256: '' }, { sha256: ['f'.repeat(64)] }, { sizeBytes: 74 }, { sizeBytes: '75' },
      { previousVersionId: undefined }, { previousVersionId: 'av_' + 'd'.repeat(24) }]) invalid(() => analysisServerIntakeAttachmentRequest(recipe(), accepted(changes)));
    const fullReceipt = accepted({ artifactId: 'af_' + 'e'.repeat(24), versionNumber: 1, createdAt: '2026-10-22T12:00:00.000Z' });
    expect(analysisServerIntakeAttachmentRequest(recipe(), fullReceipt)).toEqual(analysisServerIntakeAttachmentRequest(recipe(), accepted()));
    const other = accepted({ versionId: 'av_' + 'a'.repeat(24), sha256: 'b'.repeat(64) });
    expect(analysisServerIntakeAttachmentRequest(recipe(), other).reference).toEqual({ kind: 'artifact-version', versionId: other.versionId, sha256: other.sha256 });
    expect(canonicalAnalysisServerIntake(analysisId, recipe())).toBe(literal);
  });
  it('keeps scope and analysis identifiers strict without coercion', () => {
    for (const changes of [{ serviceId: 'svc_' + 'C'.repeat(32) }, { serviceId: ['svc_' + 'c'.repeat(32)] },
      { projectId: 'project' }, { projectId: 'proj_' + 'a'.repeat(15) }, { projectId: 'proj_' + 'a'.repeat(41) },
      { ownerUserId: '7' }, { ownerUserId: 0 }, { ownerUserId: -1 }, { ownerUserId: 1.5 }, { ownerUserId: Number.MAX_SAFE_INTEGER + 1 }]) invalid(() => normalizeAnalysisServerIntake(recipe(changes)));
    for (const bad of ['analysis', ['ra_' + 'b'.repeat(24)], 'ra_' + 'B'.repeat(24), null]) invalid(() => canonicalAnalysisServerIntake(bad, recipe()));
  });
  it('rejects private bytes, absolute paths, pre-copy SHA claims and undocumented metadata', () => {
    const input = recipe();
    for (const key of ['sha256', 'fileBytes', 'absolutePath', 'sourceKind', 'storageKey']) invalid(() => normalizeAnalysisServerIntake({ ...input, [key]: 'not admission data' }));
    for (const key of ['sha256', 'fileBytes', 'absolutePath', 'storageKey']) invalid(() => normalizeAnalysisServerIntake(recipe({ importRequest: { ...input.importRequest, [key]: 'not source selection' } })));
    for (const relativePath of ['../result.csv', '/result.csv', 'C:/result.csv', 'private\\result.csv', 'vault/result.csv', 'study/.hidden.csv']) {
      invalid(() => normalizeAnalysisServerIntake(recipe({ importRequest: { ...input.importRequest, relativePath } })));
    }
    invalid(() => normalizeAnalysisServerIntake(recipe({ attachment: { ...input.attachment, reference: accepted() } })));
  });
  it('rejects inherited, accessor, symbol, hidden, cyclic and non-plain metadata before reading computed values', () => {
    const input = recipe(); let evaluated = false;
    const getter = { ...input }; Object.defineProperty(getter, 'importRequest', { enumerable: true, get() { evaluated = true; return input.importRequest; } });
    const hidden = { ...input }; Object.defineProperty(hidden, 'selectionSizeBytes', { value: 75, enumerable: false });
    const nested = { ...input.importRequest }; Object.defineProperty(nested, 'selectionToken', { enumerable: true, get() { evaluated = true; return 'd'.repeat(64); } });
    const contextGetter = {}; Object.defineProperty(contextGetter, 'origin', { enumerable: true, get() { evaluated = true; return 'computed'; } });
    const attachmentGetter = { ...input.attachment }; Object.defineProperty(attachmentGetter, 'caption', { enumerable: true, get() { evaluated = true; return 'computed'; } });
    const cyclic = { ...input.attachment }; cyclic.suppliedOrigin = cyclic;
    for (const value of [null, [], 'recipe', getter, hidden, { ...input, [Symbol('source')]: 1 }, Object.assign(Object.create({ inherited: true }), input),
      recipe({ importRequest: nested }), recipe({ attachment: attachmentGetter }), recipe({ attachment: { ...input.attachment, suppliedOrigin: contextGetter } }), recipe({ attachment: cyclic })]) invalid(() => normalizeAnalysisServerIntake(value));
    expect(evaluated).toBe(false);
    for (const name of ['versionId', 'sha256', 'sizeBytes', 'previousVersionId', 'extra']) {
      const record = accepted(); Object.defineProperty(record, name, { enumerable: true, get() { evaluated = true; return null; } });
      invalid(() => analysisServerIntakeAttachmentRequest(input, record));
    }
    for (const value of [null, [], 'receipt', Object.assign(Object.create({ inherited: true }), accepted())]) invalid(() => analysisServerIntakeAttachmentRequest(input, value));
    expect(evaluated).toBe(false);
  });
  it('preserves UTF-16 server name/annotation limits and codepoint attachment limits while refusing malformed Unicode', () => {
    const input = recipe();
    const max = recipe({ importRequest: { ...input.importRequest, name: '🧬'.repeat(80), sampleMetadata: { condition: '🧬'.repeat(60) } },
      attachment: { ...input.attachment, caption: '🧬'.repeat(2000), suppliedOrigin: { origin: '🧬'.repeat(2000), sourceReference: '🧬'.repeat(2000),
        documentReference: '🧬'.repeat(2000), environmentReference: '🧬'.repeat(2000) } } });
    expect(normalizeAnalysisServerIntake(max).importRequest.name).toHaveLength(160);
    expect(new TextEncoder().encode(canonicalAnalysisServerIntake(analysisId, max)).length).toBeLessThanOrEqual(65536);
    for (const change of [{ name: '🧬'.repeat(81) }, { name: '\ud800' }, { relativePath: 'study/\ud800.csv' }, { sampleMetadata: { condition: '\ud800' } },
      { sampleMetadata: { condition: '🧬'.repeat(61) } }]) invalid(() => normalizeAnalysisServerIntake(recipe({ importRequest: { ...input.importRequest, ...change } })));
    for (const caption of ['\ud800', 'x'.repeat(2001), 'x\0y', '  ']) invalid(() => normalizeAnalysisServerIntake(recipe({ attachment: { ...input.attachment, caption } })));
    invalid(() => normalizeAnalysisServerIntake(recipe({ attachment: { ...input.attachment, suppliedOrigin: { origin: '\ud800' } } })));
  });
  it('leaves the existing local v1 literal and hash unchanged', () => {
    const input = { requestId, serviceId, importRequest: { schema: 'traceomics.artifact-import.v1', projectId, ownerUserId: 7, requestId,
      originalFilename: 'scores.csv', name: 'Local score', artifactType: 'auto', previousVersionId: null, sha256: 'd'.repeat(64), sizeBytes: 75 },
      attachment: { ...recipe().attachment, caption: 'Local score' } };
    const localLiteral = '{"schema":"traceomics.analysis-local-intake.v1","serviceId":"svc_cccccccccccccccccccccccccccccccc","projectId":"proj_aaaaaaaaaaaaaaaaaaaaaaaa","analysisId":"ra_bbbbbbbbbbbbbbbbbbbbbbbb","ownerUserId":7,"requestId":"abcdefab-1234-4abc-8def-abcdefabcdef","importRequest":{"schema":"traceomics.artifact-import.v1","projectId":"proj_aaaaaaaaaaaaaaaaaaaaaaaa","ownerUserId":7,"requestId":"abcdefab-1234-4abc-8def-abcdefabcdef","originalFilename":"scores.csv","name":"Local score","artifactType":"auto","previousVersionId":null,"sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sizeBytes":75},"attachment":{"requestId":"00000000-0000-4000-8000-000000000002","action":"create","attachmentId":null,"expectedHeadRevisionId":null,"caption":"Local score","suppliedOrigin":{"origin":null,"sourceReference":null,"documentReference":null,"environmentReference":null}}}';
    expect(canonicalAnalysisLocalIntake(analysisId, input)).toBe(localLiteral);
    expect(sha(canonicalAnalysisLocalIntake(analysisId, input))).toBe('a2a969a39f5dce940196eb754fb7db74bc59e0b23bbbb0db1abf971e1d01c26a');
    normalizeAnalysisServerIntake(recipe());
    expect(canonicalAnalysisLocalIntake(analysisId, input)).toBe(localLiteral);
  });
});
