import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const { createLocalStorageProvider, projectStorageFileKey } = require('./storage');
const { validateWorkflowOutput } = require('./workflowOutputs');
const { digest } = require('./workflowRuntime');
let root, provider;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'traceomics-workflow-output-')); provider = createLocalStorageProvider({ root }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function validate(type, value, changes = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const key = projectStorageFileKey('proj_workflow_test', 'artifacts', `job_${crypto.randomUUID()}`, 'output.data');
  await writeFile(provider.prepareWrite(key), bytes);
  return validateWorkflowOutput(provider, key, { type, sizeBytes: bytes.length, sha256: digest(bytes), ...changes });
}

it.each([
  ['metrics', { cells: 100, note: '<script>text only</script>' }],
  ['table', [{ cell: 'a', cluster: 0 }, { cell: 'b', cluster: 1 }]],
  ['scatter', { x: [1, 2], y: [3, 4], ids: ['a', 'b'], groups: ['One', 'Two'] }],
  ['rds', Buffer.from('opaque data, never deserialized by Node')],
])('accepts bounded %s output', async (type, value) => {
  await expect(validate(type, value)).resolves.toBeUndefined();
});

it.each([
  ['metrics', { cells: { nested: true } }],
  ['table', [{ cell: 'a' }, { different: 'b' }]],
  ['scatter', { x: [1], y: [2, 3], ids: ['a'] }],
  ['scatter', { x: [1, 2], y: [3, 4], ids: ['a', 'a'] }],
  ['scatter', { x: [1], y: [2], ids: ['a'], groups: [] }],
  ['scatter', { x: [1], y: [2], ids: ['a'], javascript: 'alert(1)' }],
])('rejects malformed %s output', async (type, value) => {
  await expect(validate(type, value)).rejects.toThrow(/declared type/);
});

it('rejects modified contents even when their structure is valid', async () => {
  await expect(validate('metrics', { cells: 100 }, { sha256: '0'.repeat(64) })).rejects.toThrow();
});

it('validates declared meaning against its output type and actual metric keys before retention', async () => {
  await expect(validate('metrics', { cells: 80 }, { semantics: { role: 'diagnostic', title: 'QC summary', metrics: { cells: { label: 'Retained cells', unit: 'cells' } } } })).resolves.toBeUndefined();
  await expect(validate('metrics', { cells: 80 }, { semantics: { metrics: { missing: { unit: 'cells' } } } })).rejects.toThrow(/unsupported field/);
  await expect(validate('scatter', { x: [1], y: [2], ids: ['a'] }, { semantics: { role: 'primary', entityType: 'cell', axes: { x: { label: 'UMAP 1' } } } })).resolves.toBeUndefined();
  await expect(validate('table', [], { semantics: { entityType: 'cell' } })).rejects.toThrow(/unsupported field/);
  await expect(validate('rds', Buffer.from('opaque'), { semantics: { role: 'guessed' } })).rejects.toThrow(/role/);
});

it('checks PNG dimensions before serving a figure', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64');
  await expect(validate('figure', png)).resolves.toBeUndefined();
  png.writeUInt32BE(50000, 16);
  await expect(validate('figure', png)).rejects.toThrow(/declared type/);
  await expect(validate('figure', Buffer.from('<svg></svg>'))).rejects.toThrow(/declared type/);
});
