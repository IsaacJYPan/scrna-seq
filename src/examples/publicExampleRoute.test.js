import { describe, expect, it } from 'vitest';
import { PUBLIC_QC_RETENTION_V1 } from '../../shared/publicSavedExample.mjs';
import { buildPublicExampleUrl, parsePublicExampleHash } from './publicExampleRoute';

describe('explicit public example navigation', () => {
  it('recognizes only the deliberately public versioned route with a literal independent golden', () => {
    expect(PUBLIC_QC_RETENTION_V1.route).toBe('#/examples/qc-retention/v1');
    expect(parsePublicExampleHash('#/examples/qc-retention/v1')).toEqual({ kind: 'public-example' });
  });
  it.each(['', '#analysis', '#/shared-snapshots/v1/unknown', null, {}, 123])('leaves unrelated route %j outside this namespace', hash => {
    expect(parsePublicExampleHash(hash)).toBeNull();
  });
  it.each(['#/examples', '#examples/qc-retention/v1', '#//examples/qc-retention/v1', '#/%2fexamples/qc-retention/v1',
    '#/ex%61mples/qc-retention/v1', '#/EXAMPLES/qc-retention/v1', '#/examples/qc-retention/v2', '#/examples/another/v1',
    '#/examples/qc-retention/v1/', '#/examples/qc-retention/v1?token=private', '#/examples/qc-retention/v1#private',
    '#/examples/qc-retention/v1/extra', '#/examples/' + 'x'.repeat(10000)])('blocks unsupported public route %j instead of opening a workspace', hash => {
    expect(parsePublicExampleHash(hash)).toEqual({ kind: 'invalid-example' });
  });
  it.each(['https://app.example/lab/', 'http://localhost:5173/', 'http://[::1]:5173/lab/', 'https://app.example/lab%20folder/index.html'])('keeps the currently served app base %s and discards unrelated private locators', base => {
    const result = buildPublicExampleUrl(base + '?private-request=keep-out#/shared-snapshots/private');
    expect(result).toBe(base + '#/examples/qc-retention/v1'); expect(result).not.toMatch(/private-request|shared-snapshots/);
  });
  it.each(['javascript:alert(1)', 'file:///example/index.html', 'data:text/html,example', 'https://user:secret@app.example/',
    'https://user@app.example/', 'https://app.example/\n', 'https://app.example/\\bad', 'not an app', '', null, {}, 'https://app.example/' + 'x'.repeat(4096)])('does not create a public navigation URL from unsupported address %j', value => {
    expect(buildPublicExampleUrl(value)).toBeNull();
  });
});
