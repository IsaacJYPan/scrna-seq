import { expect, it, vi } from 'vitest';
import { parseSharedSnapshotHash, buildSharedSnapshotHash, buildSharedSnapshotUrl } from './sharedSnapshotLink';

const target = () => ({ serviceId: 'svc_' + 'a'.repeat(32), projectId: 'proj_' + 'b'.repeat(24), analysisId: 'ra_' + 'c'.repeat(24),
  publicationId: 'aspub_' + 'd'.repeat(24), snapshotSha256: 'e'.repeat(64) });
const hash = '#/shared-snapshots/v1/svc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/proj_bbbbbbbbbbbbbbbbbbbbbbbb/ra_cccccccccccccccccccccccc/aspub_dddddddddddddddddddddddd/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const bad = { code: 'INVALID_SHARED_SNAPSHOT_LINK' };

it('preserves an independently written exact shared URL and five immutable scientific target fields', () => {
  expect(buildSharedSnapshotHash(target())).toBe(hash);
  expect(buildSharedSnapshotUrl(target(), 'https://lab.example.org/traceomics/')).toBe('https://lab.example.org/traceomics/' + hash);
  expect(parseSharedSnapshotHash(hash)).toEqual({ kind: 'snapshot', target: target() });
  const input = target(), parsed = parseSharedSnapshotHash(buildSharedSnapshotHash(input)); input.snapshotSha256 = 'f'.repeat(64);
  expect(parsed.target.snapshotSha256).toBe('e'.repeat(64)); expect(parsed.target).not.toBe(input);
});

it.each(['', '#', '#results', '#/ordinary-route', '#/examples/shared-snapshot'])('leaves ordinary existing navigation unchanged: %s', value => {
  expect(parseSharedSnapshotHash(value)).toBeNull();
});
it.each([
  '#/shared-snapshots', '#/shared-snapshots/', '#shared-snapshots/v1/', '#/shared-snapshots/v2/', '#/shared-snapshots/v99/',
  '#/SHARED-SNAPSHOTS/v1/', '#/%73hared-snapshots/v1/', '#/shared-snapshots%2fv1/', '#/shared-snapshots-extra/v1/',
  hash + '/', hash + '/ignored', hash + '?project=other', hash + '#ignored', hash.replace('/v1/', '/v01/'),
  hash.replace('/svc_', '/%73vc_'), hash.replace('/proj_', '/proj_%2f'), hash.replace('/aspub_', '/aspub_%252f'),
  hash.replace('/ra_', '/..%2fra_'), hash.replace('/ra_', '//ra_'), hash.toUpperCase(), hash + '\n',
  hash.replace('eeee', '\ud800eee'), '#/shared-snapshots/' + 'x'.repeat(600),
])('blocks malformed or unsupported shared navigation without opening the live workspace: %s', value => {
  expect(parseSharedSnapshotHash(value)).toEqual({ kind: 'invalid' });
});
it.each([undefined, null, 0, false, {}, [], new String(hash)])('does not coerce a non-string route: %s', value => {
  expect(parseSharedSnapshotHash(value)).toEqual({ kind: 'invalid' });
});

it.each([
  ['service', value => { value.serviceId = 'svc_' + 'a'.repeat(31); }],
  ['project', value => { value.projectId = 'proj_' + 'b'.repeat(15); }],
  ['analysis', value => { value.analysisId = 'ra_' + 'c'.repeat(25); }],
  ['publication', value => { value.publicationId = 'asp_' + 'd'.repeat(24); }],
  ['snapshot SHA', value => { value.snapshotSha256 = 'E'.repeat(64); }],
  ['missing immutable SHA', value => { delete value.snapshotSha256; }],
  ['private request UUID', value => { value.requestId = '00000000-0000-4000-8000-000000000001'; }],
  ['private source path', value => { value.sourcePath = '/private/source'; }],
  ['routable service claim', value => { value.serviceId = 'https://different.example.org'; }],
  ['numeric ID', value => { value.publicationId = 1; }],
  ['hidden extra', value => { Object.defineProperty(value, 'private', { value: 'secret' }); }],
  ['symbol extra', value => { value[Symbol('private')] = 'secret'; }],
])('rejects an altered or decorated target before producing any URL: %s', (_name, mutate) => {
  const value = target(); mutate(value); expect(() => buildSharedSnapshotHash(value)).toThrowError(expect.objectContaining(bad));
  expect(() => buildSharedSnapshotUrl(value, 'https://lab.example.org/')).toThrowError(expect.objectContaining(bad));
});
it('does not invoke accessors or primitive conversion, and accepts only closed plain or null-prototype records', () => {
  const getter = vi.fn(() => { throw new Error('private getter'); }), accessor = target();
  Object.defineProperty(accessor, 'serviceId', { enumerable: true, get: getter });
  for (const value of [accessor, Object.assign(Object.create({ inherited: true }), target()), [], null, { toString: getter }]) {
    expect(() => buildSharedSnapshotHash(value)).toThrowError(expect.objectContaining(bad));
  }
  expect(getter).not.toHaveBeenCalled();
  expect(buildSharedSnapshotHash(Object.assign(Object.create(null), target()))).toBe(hash);
});
it.each([16, 40])('accepts the existing exact project ID boundary of %i hex characters', length => {
  const value = { ...target(), projectId: 'proj_' + 'f'.repeat(length) };
  expect(parseSharedSnapshotHash(buildSharedSnapshotHash(value))).toEqual({ kind: 'snapshot', target: value });
});

it.each([
  ['https://lab.example.org/traceomics/?return=https%3A%2F%2Foutside.example.org#old', 'https://lab.example.org/traceomics/'],
  ['http://localhost:3000/', 'http://localhost:3000/'],
  ['http://127.0.0.1:49491/app/', 'http://127.0.0.1:49491/app/'],
  ['http://[::1]:49491/app', 'http://[::1]:49491/app'],
  ['https://LAB.EXAMPLE.ORG:443/app/index.html', 'https://lab.example.org/app/index.html'],
])('uses the currently served address/path without inventing reachability or copying queries: %s', (base, expected) => {
  expect(buildSharedSnapshotUrl(target(), base)).toBe(expected + hash);
  expect(buildSharedSnapshotUrl(target(), expected + hash)).toBe(expected + hash);
});
it.each([
  '', '/relative', '//lab.example.org/', 'file:///app/index.html', 'javascript:alert(1)', 'data:text/html,private',
  'https://user:password@lab.example.org/', 'https://user@lab.example.org/', 'https://lab.example.org\\outside',
  'https://lab.example.org/../other', 'https://lab.example.org/./app/', 'https://lab.example.org/%2e%2e/other',
  'https://lab.example.org/app%2fother/', 'https://%6cab.example.org/', 'https://lab.example.org/a b/',
  'https://lab.example.org/\nprivate', ' https://lab.example.org/', 'https://lab.example.org/\u202eprivate',
  'https://lab.example.org/' + 'x'.repeat(4100), undefined, null, {},
])('refuses an unsafe or unsupported current application URL: %s', value => {
  expect(() => buildSharedSnapshotUrl(target(), value)).toThrowError(expect.objectContaining(bad));
});
it('strips private current-page query and fragment values instead of leaking them into a copied locator', () => {
  const value = buildSharedSnapshotUrl(target(), 'https://lab.example.org/app/?requestId=private-uuid&source=/private/path#private-scratch');
  expect(value).toBe('https://lab.example.org/app/' + hash);
  expect(value).not.toMatch(/private|requestId|source=|scratch/);
});
it('bounds the complete copied URL after appending the known locator', () => {
  const base = 'https://lab.example.org/' + 'x'.repeat(3870);
  expect(base.length).toBeLessThan(4096);
  expect(() => buildSharedSnapshotUrl(target(), base)).toThrowError(expect.objectContaining(bad));
});
