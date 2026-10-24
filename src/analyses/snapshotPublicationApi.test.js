import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { listSnapshotPublications, listSnapshotPublicationRequests, getSnapshotPublication, getSnapshotPublicationRequest,
  publishAnalysisSnapshot, withdrawAnalysisSnapshot, readSnapshotPublicationView, readSnapshotPublicationDocument } from './snapshotPublicationApi';
import { withExecutionTarget } from '../runtime/executionTarget';
import { typedRecipe, typedRecord, typedMetricsBytes } from './snapshotTypedTestFixtures';
import { workflowRecipe, workflowRecord } from './snapshotWorkflowTestFixtures';
import { embeddingRecipe, embeddingRecord, embeddingBytes } from './snapshotEmbeddingTestFixtures';
import { inertRecipe, inertRecord, inertBytes } from './snapshotInertTestFixtures';

vi.mock('../api', () => ({ apiUrl: value => value }));
vi.mock('../runtime/executionTarget', () => ({ withExecutionTarget: vi.fn(fn => fn()) }));
const base = '/api/projects/project%201/analyses/analysis%201/snapshot-publications';
const bytes = new TextEncoder().encode('{"selected":"fixed"}');
const blob = { blobBytes: bytes.byteLength, blobSha256: createHash('sha256').update(bytes).digest('hex') };
const result = { viewId: 'asv_selected', source: { format: { id: 'org.ietf.csv' } }, view: { family: 'table', ...blob } };
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => vi.unstubAllGlobals());

it('separates current-reader publication discovery from actor-private accepted request discovery without writes', async () => {
  fetch.mockImplementation(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  await listSnapshotPublications('project 1', 'analysis 1', { cursor: 'older/page' });
  await listSnapshotPublicationRequests('project 1', 'analysis 1');
  await getSnapshotPublication('project 1', 'analysis 1', 'published/1');
  await getSnapshotPublicationRequest('project 1', 'analysis 1', 'own/request');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([base + '?limit=30&cursor=older%2Fpage', base + '/requests?limit=30', base + '/published%2F1', base + '/requests/own%2Frequest']);
  for (const [, options] of withExecutionTarget.mock.calls) expect(options).toEqual({ mutation: false });
});
it('sends only explicit publish and withdrawal intents once through the mutation boundary', async () => {
  fetch.mockImplementation(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  const publish = { requestId: 'own-original', snapshotSha256: 'a'.repeat(64) }, withdraw = { requestId: 'own-withdrawal', publicationId: 'published/1' };
  await publishAnalysisSnapshot('project 1', 'analysis 1', publish);
  await withdrawAnalysisSnapshot('project 1', 'analysis 1', 'published/1', withdraw);
  expect(fetch.mock.calls.map(([url, options]) => [url, options.method, JSON.parse(options.body)])).toEqual([[base, 'POST', publish], [base + '/published%2F1/withdrawals', 'POST', withdraw]]);
  for (const [, options] of withExecutionTarget.mock.calls) expect(options).toEqual({ mutation: true });
});
it('reads only the exact selected publication view/source routes and checks their bytes without original-source queries', async () => {
  fetch.mockImplementation(async () => new Response(bytes, { headers: { 'Content-Type': 'application/json' } }));
  expect(Array.from((await readSnapshotPublicationView('project 1', 'analysis 1', 'aspub_a', result)).bytes)).toEqual(Array.from(bytes));
  await readSnapshotPublicationDocument('project 1', 'analysis 1', 'aspub_a', { viewId: 'asv_source', ...blob });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([base + '/aspub_a/views/asv_selected', base + '/aspub_a/documents/asv_source']);
});

it('reads fixed3 metrics through the current-reader publication route with bounded checked JSON bytes', async () => {
  const record = typedRecord(typedRecipe({ family: 'metrics' })), metrics = record.package.results[0], content = typedMetricsBytes(metrics);
  fetch.mockResolvedValue(new Response(content, { headers: { 'Content-Type': 'application/json' } }));
  const received = await readSnapshotPublicationView('project 1', 'analysis 1', 'aspub_exact', metrics);
  expect(Array.from(received.bytes)).toEqual(Array.from(content)); expect(received.type).toBe('application/json');
  expect(fetch.mock.calls[0][0]).toBe(`${base}/aspub_exact/views/${metrics.viewId}`);
  expect(withExecutionTarget).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { mutation: false });
});

it('keeps published captured-output body access on the exact publication route without acquiring a private capture capability', async () => {
  const record = workflowRecord(workflowRecipe({ family: 'metrics' })), metrics = record.package.results[0], content = typedMetricsBytes(metrics);
  fetch.mockResolvedValue(new Response(content, { headers: { 'Content-Type': 'application/json' } }));
  expect(Array.from((await readSnapshotPublicationView('project 1', 'analysis 1', 'aspub_exact', metrics)).bytes)).toEqual(Array.from(content));
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${base}/aspub_exact/views/${metrics.viewId}`]);
  expect(withExecutionTarget).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { mutation: false });
});

it.each(['mime', 'checksum', 'length', 'size'])('refuses public fixed3 metrics %s mismatch before a checked preview can appear', async mismatch => {
  const record = typedRecord(typedRecipe({ family: 'metrics' })), metrics = record.package.results[0], content = typedMetricsBytes(metrics);
  if (mismatch === 'checksum') metrics.view.blobSha256 = 'b'.repeat(64);
  if (mismatch === 'size') metrics.view.blobBytes = 262145;
  fetch.mockResolvedValue(new Response(mismatch === 'length' ? content.subarray(1) : content,
    { headers: { 'Content-Type': mismatch === 'mime' ? 'image/png' : 'application/json' } }));
  await expect(readSnapshotPublicationView('project 1', 'analysis 1', 'aspub_exact', metrics)).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE' });
  expect(fetch).toHaveBeenCalledTimes(mismatch === 'size' ? 0 : 1);
});

it.each(['traceomics.fixed-result-view.v2', 'traceomics.fixed-result-view.v99'])('does not infer metrics JSON for unrecognized schema %s', async schema => {
  const record = typedRecord(typedRecipe({ family: 'metrics' })), metrics = record.package.results[0]; metrics.view.schema = schema;
  await expect(readSnapshotPublicationView('project 1', 'analysis 1', 'aspub_exact', metrics)).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE' });
  expect(fetch).not.toHaveBeenCalled(); expect(withExecutionTarget).not.toHaveBeenCalled();
});
it.each(['checksum', 'mime', 'length'])('refuses %s mismatch before returning retained bytes', async kind => {
  fetch.mockResolvedValue(new Response(kind === 'length' ? bytes.slice(1) : bytes, { headers: { 'Content-Type': kind === 'mime' ? 'text/html' : 'application/json' } }));
  await expect(readSnapshotPublicationView('project 1', 'analysis 1', 'aspub_a', kind === 'checksum' ? { ...result, view: { ...result.view, blobSha256: 'f'.repeat(64) } } : result)).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE' });
  expect(fetch).toHaveBeenCalledOnce();
});
it('keeps withdrawal distinct from global scope denial and never exposes a server exception', async () => {
  fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'private/source/path', code: 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN' }), { status: 409 }));
  const error = await readSnapshotPublicationView('project 1', 'analysis 1', 'aspub_a', result).catch(value => value);
  expect(error).toMatchObject({ status: 409, code: 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN' }); expect(error.message).not.toContain('private/source/path');
});
it('retains only a bounded closed already-published summary for later identity validation, without inventing acceptance', async () => {
  const publication = { publicationId: 'aspub_existing', snapshotSha256: 'a'.repeat(64) };
  fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Already published', code: 'ANALYSIS_SNAPSHOT_ALREADY_PUBLISHED', publication }), { status: 409 }));
  const error = await publishAnalysisSnapshot('project 1', 'analysis 1', {}).catch(value => value);
  expect(error.publication).toEqual(publication); expect(error.acceptance).toBeUndefined();
});
it('discards an error summary with extra private fields', async () => {
  fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Already published', code: 'ANALYSIS_SNAPSHOT_ALREADY_PUBLISHED', publication: {}, privatePath: 'private/source/path' }), { status: 409 }));
  const error = await publishAnalysisSnapshot('project 1', 'analysis 1', {}).catch(value => value);
  expect(error.publication).toBeUndefined(); expect(error.message).not.toContain('private/source/path');
});

it.each([false, true])('reads only exact fixed3 embedding JSON through current publication authority (captured: %s)', async captured => {
  const record = embeddingRecord(embeddingRecipe({ captured, pointLimit: 5 })), result = record.package.results[0], content = embeddingBytes(result), signal = new AbortController().signal;
  fetch.mockResolvedValue(new Response(content, { headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  const received = await readSnapshotPublicationView('project 1', 'analysis 1', 'aspub_exact', result, { signal });
  expect(Array.from(received.bytes)).toEqual(Array.from(content)); expect(received.type).toBe('application/json');
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`${base}/aspub_exact/views/${result.viewId}`, expect.objectContaining({ method: 'GET', signal }));
  expect(fetch.mock.calls[0][1].body).toBeUndefined(); expect(withExecutionTarget).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { mutation: false });
});

it.each(['mime', 'checksum', 'length', 'size', 'schema'])('rejects public embedding %s mismatch before returning plot bytes', async mismatch => {
  const record = embeddingRecord(), result = record.package.results[0], content = embeddingBytes(result);
  if (mismatch === 'checksum') result.view.blobSha256 = 'b'.repeat(64);
  if (mismatch === 'size') result.view.blobBytes = 262145;
  if (mismatch === 'schema') result.view.schema = 'traceomics.fixed-result-view.v99';
  fetch.mockResolvedValue(new Response(mismatch === 'length' ? content.subarray(1) : content,
    { headers: { 'Content-Type': mismatch === 'mime' ? 'image/png' : 'application/json' } }));
  await expect(readSnapshotPublicationView('project 1', 'analysis 1', 'aspub_exact', result)).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE' });
  expect(fetch).toHaveBeenCalledTimes(['size', 'schema'].includes(mismatch) ? 0 : 1);
});

it.each(['org.ietf.text', 'org.ietf.json'])('reads checked fixed4 %s only through the exact current-reader publication body route', async formatId => {
  const record = inertRecord(inertRecipe({ formatId, maxBytes: 8 }), { formats: [formatId] }), result = record.package.results[0], content = inertBytes(result);
  fetch.mockResolvedValue(new Response(content, { headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  const received = await readSnapshotPublicationView('project 1', 'analysis 1', 'aspub_exact', result);
  expect(Array.from(received.bytes)).toEqual(Array.from(content)); expect(received.type).toBe('application/json');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${base}/aspub_exact/views/${result.viewId}`]);
  expect(withExecutionTarget).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { mutation: false });
});

it.each(['source MIME', 'checksum', 'length', 'size', 'schema'])('rejects public fixed4 text %s mismatch without source or prefix fallback', async mismatch => {
  const record = inertRecord(), result = record.package.results[0], content = inertBytes(result);
  if (mismatch === 'checksum') result.view.blobSha256 = 'b'.repeat(64);
  if (mismatch === 'size') result.view.blobBytes = 262145;
  if (mismatch === 'schema') result.view.schema = 'traceomics.fixed-result-view.v2';
  fetch.mockResolvedValue(new Response(mismatch === 'length' ? content.subarray(1) : content, { headers: { 'Content-Type': mismatch === 'source MIME' ? 'text/plain' : 'application/json' } }));
  await expect(readSnapshotPublicationView('project 1', 'analysis 1', 'aspub_exact', result)).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE' });
  expect(fetch).toHaveBeenCalledTimes(['size', 'schema'].includes(mismatch) ? 0 : 1);
});
