import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  validateSnapshotPublicationList as list, validateSnapshotPublicationRequests as requests,
  validateSnapshotPublication as full, validateSnapshotPublicationReceipt as receipt,
  validateSnapshotAlreadyPublished as already,
} from './snapshotPublicationValidation';
import { validateSnapshotPackage, validateSnapshotPreparation, decodeSnapshotPreparationTable,
  decodeSnapshotPreparationDocument } from './snapshotPreparationValidation';
import { canonicalSnapshotJson, canonicalAnalysisSnapshotResultView, canonicalAnalysisSnapshotDocumentSource,
  FIXED_DOCUMENT_SOURCE_SCHEMA } from '../../shared/analysisSnapshotPreparation.mjs';
import { canonicalPublishAnalysisSnapshot, canonicalWithdrawAnalysisSnapshot } from '../../shared/analysisSnapshotPublication.mjs';
import { canonicalNotebookContent } from '../../shared/notebookDocument.mjs';
import { savedSnapshotContent } from './snapshotPreparationTestFixtures';
import { publicationScope as scope, publicationPreparation, publicationFull, publicationAnchor, publicationSummary,
  publicationList, publicationReceipt, publicationRequests, publicationTime, withdrawalTime, resealPublication } from './snapshotPublicationTestFixtures';

const hash = value => createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);
const actorScope = actor => ({ ...scope, userId: actor });
const invalid = promise => expect(promise).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE' });
const wrong = action => expect(action).toThrow(expect.objectContaining({ code: 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE' }));
const binding = value => ({ serviceId: value.serviceId, projectId: value.projectId, analysisId: value.analysisId,
  ownerUserId: value.publisherUserId, preparationId: value.preparationId, snapshotSha256: value.snapshotSha256 });
function sealReceipt(value) {
  const { action, ...body } = value.request;
  value.requestSha256 = hash((action === 'publish' ? canonicalPublishAnalysisSnapshot : canonicalWithdrawAnalysisSnapshot)(body)); return value;
}
function sealViews(value) {
  for (const item of value.package.results) {
    const { viewSha256: _ignored, ...view } = item.view; void _ignored;
    item.view.viewSha256 = hash(canonicalAnalysisSnapshotResultView({ ...view, source: { artifactId: item.source.artifactId,
      versionId: item.source.versionId, projectId: value.projectId, sha256: item.source.sha256 } }));
  }
  for (const item of value.package.documents) item.viewSha256 = hash(canonicalAnalysisSnapshotDocumentSource({ schema: FIXED_DOCUMENT_SOURCE_SCHEMA,
    source: { documentId: item.documentId, versionId: item.versionId, sha256: item.sha256 }, blobSha256: item.blobSha256, blobBytes: item.blobBytes }));
  return resealPublication(value);
}

describe('neutral immutable package verifier', () => {
  it('checks the real package without a synthetic private request or current viewer', async () => {
    const value = publicationFull();
    expect(await validateSnapshotPackage(value.package, binding(value))).toEqual(value.package);
    const prepared = publicationPreparation();
    expect(await validateSnapshotPreparation(prepared, actorScope(7), prepared.recipe)).toEqual(prepared);
  });
  for (const [field, value] of [['ownerUserId', 17], ['serviceId', 'svc_' + '2'.repeat(32)],
    ['projectId', 'proj_' + '4'.repeat(16)], ['analysisId', 'ra_' + '5'.repeat(24)],
    ['preparationId', 'asp_' + '6'.repeat(24)], ['snapshotSha256', 'f'.repeat(64)]]) {
    it(`requires the independent exact package ${field} binding`, async () => {
      const result = publicationFull(); await expect(validateSnapshotPackage(result.package, { ...binding(result), [field]: value })).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' });
    });
  }
  it('requires all six binding fields and rejects private or audience claims', async () => {
    const value = publicationFull(), missing = binding(value); delete missing.snapshotSha256;
    await expect(validateSnapshotPackage(value.package, missing)).rejects.toThrow();
    await expect(validateSnapshotPackage(value.package, { ...binding(value), viewerUserId: 17 })).rejects.toThrow();
  });
  it('captures package and binding before a held digest', async () => {
    const value = publicationFull(), expected = copy(value.package), bound = binding(value);
    let release; const gate = new Promise(resolve => { release = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await gate; return webcrypto.subtle.digest(...args); });
    try {
      const pending = validateSnapshotPackage(value.package, bound); value.package.analysis.name = 'new mutable head'; bound.ownerUserId = 17;
      release(); expect(await pending).toEqual(expected);
    } finally { release(); spy.mockRestore(); }
  });
});

describe('current-member publication full detail', () => {
  it('binds publisher, current viewer and immutable acknowledged package separately', async () => {
    const value = publicationFull(); expect(value.publisherUserId).not.toBe(value.viewerUserId);
    expect(await full(value, scope, publicationAnchor(value))).toEqual(value);
    expect(await full(value, { ...scope, userId: '17' }, { publicationId: value.publicationId, snapshotSha256: value.snapshotSha256 })).toEqual(value);
  });
  it('requires a bound service and independent SHA anchor for an opaque ID', async () => {
    const value = publicationFull(), unbound = { ...scope }; delete unbound.serviceId;
    await invalid(full(value, unbound, publicationAnchor(value)));
    await invalid(full(value, scope)); await invalid(full(value, scope, { publicationId: value.publicationId }));
    await invalid(full(value, scope, { ...publicationAnchor(value), snapshotSha256: 'f'.repeat(64) }));
  });
  it('allows current profile labels/role flags/availability to change without changing accepted science', async () => {
    const value = publicationFull(), anchor = publicationAnchor(value);
    value.publisherLabel = '🧬'.repeat(100); value.canPublish = true; value.canWithdraw = true;
    value.availability.status = 'unavailable'; value.availability.views[0].status = 'unavailable';
    expect((await full(value, scope, anchor)).snapshotSha256).toBe(anchor.snapshotSha256);
  });
  it('preserves copied codepoint-length historical names/captions and scientific control strings', async () => {
    const value = publicationFull(); value.package.analysis.name = '🧬'.repeat(159) + '\u0085';
    value.package.results[0].attachment.caption = '🧬'.repeat(2000);
    resealPublication(value); expect(await full(value, scope, publicationAnchor(value))).toEqual(value);
    expect(list(publicationList([value]), scope).items[0].selection.analysisName).toBe(value.package.analysis.name);
  });
  for (const format of ['org.ietf.csv', 'org.iana.tsv', 'org.w3.png', 'org.iso.jpeg']) {
    it(`reuses exact package/view rules for ${format}`, async () => {
      const value = publicationFull(), item = value.package.results[0]; item.source.format.id = format;
      if (['org.w3.png', 'org.iso.jpeg'].includes(format)) {
        Object.assign(item.view, { family: 'image', spec: null, width: 12, height: 10, blobSha256: item.source.sha256, blobBytes: item.source.sizeBytes });
      }
      sealViews(value); expect(await full(value, scope, publicationAnchor(value))).toEqual(value);
    });
  }
  it('keeps withdrawn acceptance identity but strips every protected package/body', async () => {
    const value = publicationFull({ state: 'withdrawn' }); expect(await full(value, scope, publicationAnchor(value))).toEqual(value);
    value.package = publicationFull().package; await invalid(full(value, scope, publicationAnchor(value)));
  });
  const mutations = [
    ['foreign viewer', v => { v.viewerUserId = 7; }], ['foreign publisher', v => { v.publisherUserId = 17; }],
    ['scope service', v => { v.serviceId = 'svc_' + '2'.repeat(32); }], ['scope project', v => { v.projectId = 'proj_' + '4'.repeat(16); }],
    ['scope analysis', v => { v.analysisId = 'ra_' + '4'.repeat(24); }], ['preparation', v => { v.preparationId = 'asp_' + '4'.repeat(24); }],
    ['wrong package SHA', v => { v.snapshotSha256 = 'e'.repeat(64); }], ['new current head', v => { v.package.analysis.version++; }],
    ['source import metadata', v => { v.package.results[0].source.import = { path: '/private/data' }; }],
    ['private request UUID', v => { v.requestId = '12345678-1234-4234-8234-123456789abc'; }],
    ['current permission type', v => { v.canPublish = 'true'; }], ['withdraw flag type', v => { v.canWithdraw = 1; }],
    ['invalid published version', v => { v.policy.version = 2; }], ['premature withdrawal actor', v => { v.policy.withdrawnByUserId = 7; }],
    ['source availability masquerade', v => { v.availability.originalSources = []; }],
    ['missing availability', v => { v.availability.views = []; }], ['wrong availability identity', v => { v.availability.views[0].viewId = 'asv_' + 'f'.repeat(24); }],
    ['lying aggregate', v => { v.availability.status = 'unavailable'; }], ['unsafe publisher control', v => { v.publisherLabel = 'Researcher\u200b'; }],
    ['untrimmed publisher', v => { v.publisherLabel = ' Researcher'; }], ['overlong publisher', v => { v.publisherLabel = 'x'.repeat(201); }],
    ['malformed label Unicode', v => { v.publisherLabel = '\ud800'; }], ['empty publisher', v => { v.publisherLabel = ''; }],
    ['noncanonical timestamp', v => { v.publishedAt = '2026-10-22T12:05:00Z'; }],
  ];
  for (const [label, mutate] of mutations) it(`rejects ${label}`, async () => {
    const value = publicationFull(), anchor = publicationAnchor(value); mutate(value); await invalid(full(value, scope, anchor));
  });
  it('rejects recomputed outer package SHA hiding a corrupted result or source descriptor SHA', async () => {
    for (const part of ['result', 'document']) {
      const value = publicationFull(); if (part === 'result') value.package.results[0].view.viewSha256 = 'f'.repeat(64);
      else value.package.documents[0].viewSha256 = 'f'.repeat(64);
      resealPublication(value); await invalid(full(value, scope, publicationAnchor(value)));
    }
  });
  it('rejects publisher/viewer identity substitution even with newly computed package SHA', async () => {
    const value = publicationFull(); value.package.ownerUserId = 17; value.package.results[0].attachment.sourceOwnerUserId = 17;
    resealPublication(value); await invalid(full(value, scope, publicationAnchor(value)));
  });
  it('requires publisher withdrawal to remain allowed after a reader downgrade', async () => {
    const value = publicationFull({ viewerUserId: 7 }); value.canWithdraw = false;
    await invalid(full(value, actorScope(7), publicationAnchor(value)));
  });
  it('captures body/scope/selected anchor before the first digest await', async () => {
    const value = publicationFull(), expected = copy(value), currentScope = { ...scope }, anchor = publicationAnchor(value);
    let release; const gate = new Promise(resolve => { release = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await gate; return webcrypto.subtle.digest(...args); });
    try {
      const pending = full(value, currentScope, anchor); value.package.results[0].attachment.caption = 'changed'; currentScope.userId = 7; anchor.snapshotSha256 = 'f'.repeat(64);
      release(); expect(await pending).toEqual(expected);
    } finally { release(); spy.mockRestore(); }
  });
});

describe('bounded colleague and actor-private discovery', () => {
  it('discovers public history without operation UUIDs and redacts withdrawn selection', () => {
    const value = publicationFull(), withdrawn = publicationFull({ state: 'withdrawn', publicationId: 'aspub_' + 'c'.repeat(24) });
    const result = list(publicationList([value, withdrawn]), scope);
    expect(result.items[1].selection).toBeNull(); expect(result.items[0]).not.toHaveProperty('requestId');
    const unbound = { ...scope }; delete unbound.serviceId; expect(list(publicationList([value]), unbound)).toEqual(publicationList([value]));
    expect(list(publicationList([value]), { ...unbound, serviceId: undefined })).toEqual(publicationList([value]));
  });
  it('accepts normal and administrator private action discovery without leaking another actor journal', async () => {
    const accepted = publicationReceipt(), withdrawn = publicationReceipt({ action: 'withdraw', actorUserId: 99 });
    expect(await requests(publicationRequests([accepted]), actorScope(7))).toEqual(publicationRequests([accepted]));
    const adminList = publicationRequests([withdrawn], { scope: actorScope(99) });
    expect(await requests(adminList, actorScope(99))).toEqual(adminList);
    await invalid(requests(adminList, actorScope(7)));
  });
  it('accepts original publish+withdraw receipts with the same current withdrawn policy', async () => {
    const current = publicationFull({ viewerUserId: 7, state: 'withdrawn' });
    const values = [publicationReceipt({ current }), publicationReceipt({ action: 'withdraw', current })];
    const result = publicationRequests(values); expect((await requests(result, actorScope(7))).items).toHaveLength(2);
  });
  it('verifies private summary request hashes rather than treating accepted shape as proof', async () => {
    const value = publicationRequests([publicationReceipt()]); value.items[0].request.snapshotSha256 = 'f'.repeat(64);
    await invalid(requests(value, actorScope(7)));
  });
  it('rejects out-of-order, duplicate, oversized and cross-viewer collections', async () => {
    const first = publicationFull(), second = publicationFull({ publicationId: 'aspub_' + 'c'.repeat(24) });
    const reverse = publicationList([first, second]); reverse.items.reverse(); wrong(() => list(reverse, scope));
    wrong(() => list(publicationList([first, first]), scope));
    wrong(() => list(publicationList(Array.from({ length: 31 }, () => first)), scope));
    wrong(() => list(publicationList([first]), actorScope(7)));
    const privateReverse = publicationRequests([publicationReceipt({ current: publicationFull({ viewerUserId: 7, state: 'withdrawn' }) }), publicationReceipt({ action: 'withdraw' })]);
    privateReverse.items.reverse(); await invalid(requests(privateReverse, actorScope(7)));
  });
  for (const cursor of ['', 'x'.repeat(257), 'not/a/cursor', 17]) it(`rejects malformed cursor ${String(cursor).slice(0, 30)}`, async () => {
    const publicValue = publicationList([publicationFull()]); publicValue.nextCursor = cursor; wrong(() => list(publicValue, scope));
    const privateValue = publicationRequests([publicationReceipt()]); privateValue.nextCursor = cursor; await invalid(requests(privateValue, actorScope(7)));
  });
  it('rejects continuation on empty pages and private fields in colleague summaries', () => {
    wrong(() => list(publicationList([], { nextCursor: 'abc' }), scope));
    const value = publicationList([publicationFull()]); value.items[0].request = publicationReceipt().request; wrong(() => list(value, scope));
    const withdrawn = publicationList([publicationFull({ state: 'withdrawn' })]); withdrawn.items[0].selection = publicationSummary(publicationFull()).selection;
    wrong(() => list(withdrawn, scope));
  });
});

describe('original publish/withdraw acceptance and separate current policy', () => {
  it('verifies original publication receipt and acknowledged exact request', async () => {
    const value = publicationReceipt(); expect(await receipt(value, actorScope(7), value.request)).toEqual(value);
    expect(value.current.publisherUserId).toBe(7); expect(value.actorUserId).toBe(7);
  });
  it('recovers original publish acceptance after downgrade/private deletion/withdrawal without a body bypass', async () => {
    const value = publicationReceipt({ replayed: true, current: publicationFull({ viewerUserId: 7, state: 'withdrawn' }) });
    expect(await receipt(value, actorScope(7), value.request)).toEqual(value);
    expect(value.acceptance.acceptedAt).toBe(publicationTime); expect(value.current.policy.withdrawnAt).toBe(withdrawalTime);
    expect(value.current.package).toBeNull(); expect(value.current.canPublish).toBe(false);
  });
  it('accepts administrator withdrawal actor independently from original publisher', async () => {
    const value = publicationReceipt({ action: 'withdraw', actorUserId: 99, publisherUserId: 7, replayed: true });
    expect(await receipt(value, actorScope(99), value.request)).toEqual(value);
    expect(value.request.ownerUserId).toBe(99); expect(value.current.publisherUserId).toBe(7);
  });
  it('preserves distinct effect and receipt clock timestamps with correct ordering', async () => {
    const published = publicationReceipt(); published.acceptance.acceptedAt = '2026-10-22T12:05:00.019Z';
    expect(await receipt(published, actorScope(7))).toEqual(published);
    const withdrawn = publicationReceipt({ action: 'withdraw', actorUserId: 99 });
    withdrawn.acceptance.acceptedAt = '2026-10-22T12:10:00.023Z';
    expect(await receipt(withdrawn, actorScope(99))).toEqual(withdrawn);
    const discovery = publicationRequests([withdrawn], { scope: actorScope(99) });
    expect(await requests(discovery, actorScope(99))).toEqual(discovery);
  });
  for (const [name, mutate] of [
    ['actor viewer substitution', v => { v.current.viewerUserId = 17; }], ['request actor substitution', v => { v.request.ownerUserId = 17; }],
    ['foreign journal actor', v => { v.actorUserId = 17; }], ['request UUID substitution', v => { v.requestId = '12345678-1234-4234-8234-123456789abd'; }],
    ['acceptance SHA', v => { v.acceptance.snapshotSha256 = 'f'.repeat(64); }], ['acceptance action', v => { v.acceptance.action = 'withdraw'; }],
    ['acceptance version', v => { v.acceptance.acceptedPolicyVersion = 2; }], ['different accepted publication', v => { v.acceptance.publicationId = 'aspub_' + 'e'.repeat(24); }],
    ['receipt before effect time', v => { v.acceptance.acceptedAt = '2026-10-22T12:04:59.999Z'; }], ['invalid audit identity', v => { v.acceptance.auditEventId = 'aud_fake'; }],
    ['unverified request hash', v => { v.requestSha256 = 'f'.repeat(64); }], ['unrecorded status', v => { v.status = 'accepted'; }],
  ]) it(`rejects ${name}`, async () => {
    const value = publicationReceipt(); mutate(value); await invalid(receipt(value, actorScope(7)));
  });
  it('rejects changed original target/scope even when request hash was recomputed', async () => {
    const value = publicationReceipt(), original = copy(value.request); value.request.preparationId = 'asp_' + 'e'.repeat(24); sealReceipt(value);
    await invalid(receipt(value, actorScope(7), original)); await invalid(receipt(value, actorScope(7)));
  });
  it('rejects a withdrawal response that resurrects policy or claims a different winning actor/time', async () => {
    const value = publicationReceipt({ action: 'withdraw', actorUserId: 99 }); value.current = publicationFull({ viewerUserId: 99 });
    await invalid(receipt(value, actorScope(99)));
    const actor = publicationReceipt({ action: 'withdraw', actorUserId: 99 }); actor.current.policy.withdrawnByUserId = 7;
    await invalid(receipt(actor, actorScope(99)));
  });
  it('captures original expected intent and nested current data before digest suspension', async () => {
    const value = publicationReceipt(), original = copy(value), expected = copy(value.request), currentScope = actorScope(7);
    let release; const gate = new Promise(resolve => { release = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await gate; return webcrypto.subtle.digest(...args); });
    try {
      const pending = receipt(value, currentScope, expected); value.current.package = null; expected.preparationId = 'asp_' + 'e'.repeat(24); currentScope.userId = 99;
      release(); expect(await pending).toEqual(original);
    } finally { release(); spy.mockRestore(); }
  });
});

describe('closed open-existing conflict and hostile input handling', () => {
  const conflict = () => ({ error: 'This preparation already has a published snapshot.', code: 'ANALYSIS_SNAPSHOT_ALREADY_PUBLISHED',
    publication: publicationSummary(publicationFull({ viewerUserId: 7 })) });
  const acknowledged = value => ({ preparationId: value.publication.preparationId, snapshotSha256: value.publication.snapshotSha256 });
  it('offers only the exact existing owned package without inventing a losing UUID acceptance', () => {
    const value = conflict(); expect(already(value, actorScope(7), acknowledged(value))).toEqual(value);
    expect(already(value, actorScope(7), acknowledged(value))).not.toHaveProperty('acceptance');
  });
  it('rejects wrong owner/package/preparation, withdrawn conflict and unsupported fields', () => {
    const value = conflict(); wrong(() => already(value, scope, acknowledged(value)));
    wrong(() => already(value, actorScope(7), { ...acknowledged(value), snapshotSha256: 'f'.repeat(64) }));
    wrong(() => already(value, actorScope(7), { ...acknowledged(value), preparationId: 'asp_' + 'e'.repeat(24) }));
    value.requestId = '12345678-1234-4234-8234-123456789abc'; wrong(() => already(value, actorScope(7), acknowledged(value)));
  });
  it('does not invoke unsafe response/scope/anchor accessors, hidden keys or toJSON', async () => {
    let reads = 0;
    for (const where of ['body', 'scope', 'anchor']) {
      const value = publicationFull(), expectedScope = { ...scope }, anchor = publicationAnchor(value);
      const object = where === 'body' ? value : where === 'scope' ? expectedScope : anchor;
      Object.defineProperty(object, where === 'body' ? 'package' : where === 'scope' ? 'userId' : 'snapshotSha256', {
        enumerable: true, get() { reads++; throw Error('unsafe'); },
      });
      await invalid(full(value, expectedScope, anchor));
    }
    const hidden = publicationFull(); Object.defineProperty(hidden, 'secret', { value: 'private' }); await invalid(full(hidden, scope, publicationAnchor(hidden)));
    const cycle = publicationFull(); cycle.package.cycle = cycle; await invalid(full(cycle, scope, publicationAnchor(cycle)));
    const prototype = Object.assign(Object.create({ inherited: 1 }), publicationFull()); await invalid(full(prototype, scope, publicationAnchor(prototype)));
    expect(reads).toBe(0);
  });
  it('retains cross-realm verified byte decoding through the shared real renderer decoders', async () => {
    const value = publicationFull(); await full(value, scope, publicationAnchor(value));
    const table = { family: 'table', columns: ['sample', 'value'], rows: [['donor α', '3']], offset: 0, limit: 25, hasMore: false, scannedRows: 1, truncated: false };
    const tableBytes = new TextEncoder().encode(canonicalSnapshotJson(table));
    const crossRealm = runInNewContext(`Uint8Array.from(${JSON.stringify([...tableBytes])})`);
    expect(await decodeSnapshotPreparationTable(crossRealm, value.package.results[0])).toEqual(table);
    const sourceBytes = Buffer.from(canonicalNotebookContent(savedSnapshotContent));
    expect(await decodeSnapshotPreparationDocument(sourceBytes, value.package.documents[0])).toEqual(savedSnapshotContent);
    await expect(decodeSnapshotPreparationTable(new DataView(tableBytes.buffer), value.package.results[0])).rejects.toThrow();
  });
});
