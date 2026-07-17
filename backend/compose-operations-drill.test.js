import { describe, expect, it, vi } from 'vitest';

const { cleanupContainerOwnedBackup } = require('../scripts/verify-compose-operations-drill');

describe('Compose operations drill cleanup', () => {
  it('removes the container-owned backup with the existing non-root operations service', () => {
    const composeFn = vi.fn(() => 'removed');

    const result = cleanupContainerOwnedBackup(composeFn, 'b7ops123src', '/tmp/source.env');

    expect(result).toBe('removed');
    expect(composeFn).toHaveBeenCalledWith('b7ops123src', '/tmp/source.env', [
      '--profile', 'operations',
      'run', '-T', '--rm', '--no-deps',
      '--entrypoint', '/bin/rm',
      'operations', '-rf', '--', '/app/backups/source-backup',
    ]);
    expect(composeFn.mock.calls[0][2]).not.toContain('--user');
  });
});
