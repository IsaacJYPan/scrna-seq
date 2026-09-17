'use strict';

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const scalar = value => value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 2000);
function invalid() { throw new Error('Workflow output does not match its declared type or size limit.'); }

async function validateWorkflowOutput(provider, key, descriptor) {
  const file = await provider.openVerifiedRead(key, { checksumSha256: descriptor.sha256, sizeBytes: descriptor.sizeBytes });
  try {
    if (descriptor.type === 'rds') return; // Deserialization remains exclusively inside the sandbox.
    if (descriptor.type === 'figure') {
      const header = Buffer.alloc(33);
      const { bytesRead } = await file.handle.read(header, 0, header.length, 0);
      if (bytesRead !== 33 || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          || header.toString('ascii', 12, 16) !== 'IHDR') invalid();
      const width = header.readUInt32BE(16); const height = header.readUInt32BE(20);
      if (!width || !height || width > 8192 || height > 8192 || width * height > 25000000) invalid();
      return;
    }
    if (descriptor.sizeBytes > MAX_JSON_BYTES) invalid();
    const value = JSON.parse(await file.handle.readFile({ encoding: 'utf8' }));
    if (descriptor.type === 'metrics') {
      if (!plain(value) || Object.keys(value).length > 40 || Object.entries(value).some(([key, item]) => key.length > 100 || !scalar(item))) invalid();
    } else if (descriptor.type === 'table') {
      if (!Array.isArray(value) || value.length > 50000) invalid();
      const columns = value.length ? Object.keys(value[0] || {}) : [];
      if (columns.length > 100 || columns.some(key => key.length > 100)) invalid();
      for (const row of value) if (!plain(row) || Object.keys(row).length !== columns.length || columns.some(key => !Object.hasOwn(row, key) || !scalar(row[key]))) invalid();
    } else if (descriptor.type === 'scatter') {
      if (!plain(value) || Object.keys(value).some(key => !['x', 'y', 'ids', 'groups'].includes(key))
          || !Array.isArray(value.x) || value.x.length > 100000 || !Array.isArray(value.y)
          || value.y.length !== value.x.length || !Array.isArray(value.ids) || value.ids.length !== value.x.length
          || value.x.some(x => !Number.isFinite(x)) || value.y.some(y => !Number.isFinite(y))
          || value.ids.some(id => typeof id !== 'string' || id.length > 200)
          || new Set(value.ids).size !== value.ids.length) invalid();
      if (value.groups !== undefined && (!Array.isArray(value.groups) || value.groups.length !== value.x.length
          || value.groups.some(group => typeof group !== 'string' || group.length > 100) || new Set(value.groups).size > 40)) invalid();
    } else invalid();
  } finally { await file.handle.close(); }
}

module.exports = { validateWorkflowOutput };
