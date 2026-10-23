import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_SNAPSHOT_PUBLICATION_SCHEMA as SCHEMA, ANALYSIS_SNAPSHOT_PUBLICATION_LIMITS as L,
  ANALYSIS_SNAPSHOT_PUBLICATION_ID as ID, normalizePublishAnalysisSnapshot as publish,
  canonicalPublishAnalysisSnapshot as publishCanonical, normalizeWithdrawAnalysisSnapshot as withdraw,
  canonicalWithdrawAnalysisSnapshot as withdrawCanonical,
} from '../shared/analysisSnapshotPublication.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const request = (action = 'publish') => ({ requestId: '12345678-1234-4234-8234-123456789abc',
  serviceId: 'svc_' + '1'.repeat(32), projectId: 'proj_' + '2'.repeat(16), analysisId: 'ra_' + '3'.repeat(24),
  ownerUserId: 7, ...(action === 'publish' ? { preparationId: 'asp_' + '4'.repeat(24) } : { publicationId: 'aspub_' + '5'.repeat(24) }), snapshotSha256: 'a'.repeat(64) });
const literalPublish = '{"schema":"traceomics.analysis-snapshot-publication.v1","action":"publish","serviceId":"svc_11111111111111111111111111111111","projectId":"proj_2222222222222222","analysisId":"ra_333333333333333333333333","ownerUserId":7,"requestId":"12345678-1234-4234-8234-123456789abc","preparationId":"asp_444444444444444444444444","snapshotSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
const literalWithdraw = '{"schema":"traceomics.analysis-snapshot-publication.v1","action":"withdraw","serviceId":"svc_11111111111111111111111111111111","projectId":"proj_2222222222222222","analysisId":"ra_333333333333333333333333","ownerUserId":7,"requestId":"12345678-1234-4234-8234-123456789abc","publicationId":"aspub_555555555555555555555555","snapshotSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';

describe('exact snapshot publication intent', () => {
  it('fixes namespace and finite request/receipt/discovery limits', () => {
    expect(SCHEMA).toBe('traceomics.analysis-snapshot-publication.v1');
    expect(ID.test(request('withdraw').publicationId)).toBe(true); expect(ID.test(request().preparationId)).toBe(false);
    expect(Object.isFrozen(L)).toBe(true);
    expect(L).toEqual({ publications: 2000, requestBytes: 2048, metadataAllowanceBytes: 8192,
      page: 30, cursor: 256, listBytes: 131072, fullBytes: 393216, publisherLabel: 200, verificationConcurrency: 2 });
  });
  it('keeps independent literal canonical publish and withdraw hashes', () => {
    expect(publishCanonical(request())).toBe(literalPublish);
    expect(hash(publishCanonical(request()))).toBe('586aa1a69a304fbb859d7be341c68234004f3d5a9b4cbe39eb7843ab94e7c066');
    expect(withdrawCanonical(request('withdraw'))).toBe(literalWithdraw);
    expect(hash(withdrawCanonical(request('withdraw')))).toBe('4a61ef1e285fc990e3f2b219577db0a2dbe53413ab587e6f7f9354cca48c989c');
  });
  for (const [action, normalize, canonical] of [['publish', publish, publishCanonical], ['withdraw', withdraw, withdrawCanonical]]) {
    it(`${action} captures a fresh plain copy and normalizes only UUID case`, () => {
      const original = request(action); original.requestId = original.requestId.toUpperCase();
      const result = normalize(Object.assign(Object.create(null), Object.fromEntries(Object.entries(original).reverse())));
      expect(result.requestId).toBe(request().requestId); expect(original.requestId).toBe(request().requestId.toUpperCase());
      result.ownerUserId = 8; expect(original.ownerUserId).toBe(7);
      expect(canonical(original)).toBe(action === 'publish' ? literalPublish : literalWithdraw);
    });
    for (const [field, bad] of [
      ['requestId', '00000000-0000-0000-0000-000000000000'], ['requestId', 'x'.repeat(2049)],
      ['serviceId', 'svc_' + 'A'.repeat(32)], ['projectId', '../project'], ['analysisId', 'ra_é'],
      ['ownerUserId', '7'], ['ownerUserId', 0], ['ownerUserId', -1], ['ownerUserId', 1.5],
      ['ownerUserId', Number.MAX_SAFE_INTEGER + 1], ['ownerUserId', NaN], ['ownerUserId', Infinity],
      ['snapshotSha256', 'A'.repeat(64)], ['snapshotSha256', 'a'.repeat(63)],
    ]) it(`${action} rejects malformed ${field} ${String(bad).slice(0, 35)}`, () => {
      expect(() => normalize({ ...request(action), [field]: bad })).toThrow(expect.objectContaining({ status: 400 }));
    });
    it(`${action} binds every identity and exact target to its fingerprint`, () => {
      const r = request(action), target = action === 'publish' ? 'preparationId' : 'publicationId';
      for (const changes of [{ ownerUserId: 8 }, { serviceId: 'svc_' + '2'.repeat(32) }, { projectId: 'proj_' + '3'.repeat(16) },
        { analysisId: 'ra_' + '4'.repeat(24) }, { requestId: '12345678-1234-4234-8234-123456789abd' },
        { [target]: (action === 'publish' ? 'asp_' : 'aspub_') + '6'.repeat(24) }, { snapshotSha256: 'b'.repeat(64) }]) {
        expect(hash(canonical({ ...r, ...changes }))).not.toBe(hash(canonical(r)));
      }
    });
    for (const field of ['package', 'bytes', 'grant', 'sourceOwnerUserId', 'actorUserId', 'reason', 'action', '__proto__']) {
      it(`${action} rejects an unsupported ${field} claim`, () => {
        const value = request(action); Object.defineProperty(value, field, { enumerable: true, value: null });
        expect(() => normalize(value)).toThrow();
      });
    }
    it(`${action} refuses wrong target kind, missing field and forged prototypes`, () => {
      expect(() => normalize(request(action === 'publish' ? 'withdraw' : 'publish'))).toThrow();
      const value = request(action); delete value.snapshotSha256; expect(() => normalize(value)).toThrow();
      expect(() => normalize(Object.assign(Object.create({ inherited: 1 }), request(action)))).toThrow();
      expect(() => normalize([])).toThrow(); expect(() => normalize(null)).toThrow();
    });
    it(`${action} never invokes input getters, toJSON or iterators`, () => {
      let reads = 0;
      for (const key of ['requestId', 'toJSON', Symbol.iterator]) {
        const value = request(action); Object.defineProperty(value, key, { enumerable: true, get() { reads++; throw Error('unsafe'); } });
        expect(() => normalize(value)).toThrow();
      }
      const hidden = request(action); Object.defineProperty(hidden, 'hidden', { value: 'secret' });
      expect(() => normalize(hidden)).toThrow(); expect(reads).toBe(0);
    });
  }
  it('allows an administrator action owner distinct from the immutable publisher', () => {
    expect(withdraw({ ...request('withdraw'), ownerUserId: 99 }).ownerUserId).toBe(99);
    expect(withdrawCanonical({ ...request('withdraw'), ownerUserId: 99 })).toContain('"ownerUserId":99');
  });
});
