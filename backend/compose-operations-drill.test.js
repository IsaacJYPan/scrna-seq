import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  cleanupContainerOwnedBackup,
  writeEnvironment,
} = require('../scripts/verify-compose-operations-drill');

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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

  it('declares the private mode required by the fail-closed topology', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-compose-env-test-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'acceptance.env');

    writeEnvironment(file, 39001, {
      sessionSecret: 'a'.repeat(64),
      sessionEpoch: 'b'.repeat(32),
      rToken: 'c'.repeat(64),
      databasePassword: 'd'.repeat(64),
    }, path.join(directory, 'backups'));

    const variables = new Map(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    expect(variables.get('APP_DEPLOYMENT_MODE')).toBe('private');
  });
});
