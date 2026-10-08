import { describe, expect, it } from 'vitest';

const { verifyDurableDatabaseReferences } = require('./verify-backup-restore.js');
const key = 'projects/proj_test/artifacts/av_0123456789abcdef01234567/content.csv';
const sha256 = 'a'.repeat(64);

function restoredDatabase(version) {
  return { query: async sql => {
    if (sql.includes('to_regclass')) return { rows: [{ name: 'managed_artifact_versions' }] };
    if (sql.includes('FROM managed_artifact_versions')) return { rows: [version] };
    if (sql.includes('FROM analysis_objects')) return { rows: [{ count: 0 }] };
    return { rows: [] };
  } };
}
const version = { id: 'av_0123456789abcdef01234567', storage_key: key, size_bytes: '31', checksum_sha256: sha256 };

describe('restored managed artifact integrity', () => {
  it('verifies managed versions against the exact restored file inventory', async () => {
    const result = await verifyDurableDatabaseReferences(restoredDatabase(version), [{ path: key, sizeBytes: 31, sha256 }]);
    expect(result.checkedManagedVersions).toBe(1);
  });

  it.each([
    ['missing bytes', [], /absent/],
    ['changed checksum', [{ path: key, sizeBytes: 31, sha256: 'b'.repeat(64) }], /checksum/],
    ['changed size', [{ path: key, sizeBytes: 32, sha256 }], /size/],
  ])('rejects %s before accepting restored references', async (_label, inventory, message) => {
    await expect(verifyDurableDatabaseReferences(restoredDatabase(version), inventory)).rejects.toThrow(message);
  });
});
