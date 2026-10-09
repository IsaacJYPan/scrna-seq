import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const { serverDataImportRoots, relativeSelection, importLimits } = require('./serverDataImportConfig');
const base = path.join(os.tmpdir(), 'traceomics-server-data-config');
const options = { cwd: path.join(base, 'app'), home: path.join(base, 'home') };
const valid = { id: 'study-data', label: 'Study data', path: path.join(base, 'source'), grants: [{ projectId: 'proj_study', ownerUserId: 42 }] };
const env = values => ({ SERVER_DATA_IMPORT_ROOTS: JSON.stringify(values), STORAGE_ROOT: path.join(base, 'storage'), VAULT_ROOT: path.join(base, 'vault') });

describe('operator-scoped server data configuration', () => {
  it('defaults to no sources and parses exact immutable project/account grants', () => {
    expect(serverDataImportRoots({}, options)).toEqual([]);
    const roots = serverDataImportRoots(env([valid]), options);
    expect(roots).toEqual([valid]); expect(Object.isFrozen(roots[0].grants)).toBe(true);
    expect(importLimits({})).toMatchObject({ maxFileBytes: 512 * 1024 ** 2, managedQuotaBytes: 5 * 1024 ** 3, maximumPageEntries: 100 });
  });
  it.each(['{', '{}', JSON.stringify([null]), 'x'.repeat(65537)])('rejects malformed or oversized configuration without including private values', raw => {
    expect(() => serverDataImportRoots({ SERVER_DATA_IMPORT_ROOTS: raw }, options)).toThrow(/SERVER_DATA_IMPORT_ROOTS/);
  });
  it('requires exact grants and distinct source identities', () => {
    for (const root of [{ ...valid, grants: [{ projectId: '*', ownerUserId: 42 }] }, { ...valid, grants: [{ projectId: 'proj_study', ownerUserId: '*' }] },
      { ...valid, grants: [{ projectId: 'proj_study', ownerUserId: 42, role: 'any' }] }, { ...valid, grants: [...valid.grants, ...valid.grants] }, { ...valid, token: 'private' }]) {
      expect(() => serverDataImportRoots(env([root]), options)).toThrow();
    }
    expect(() => serverDataImportRoots(env([valid, valid]), options)).toThrow();
    expect(() => serverDataImportRoots(env([valid, { ...valid, id: 'nested', path: path.join(valid.path, 'nested') }]), options)).toThrow();
  });
  it('rejects broad, application, durable, vault, hidden, and credential roots', () => {
    const forbidden = [path.parse(base).root, options.home, base, options.cwd, path.join(options.cwd, 'datasets'), path.join(base, 'storage'),
      path.join(base, 'vault'), path.join(options.home, '.ssh'), path.join(base, '.secrets'), path.join(base, 'node_modules')];
    for (const directory of forbidden) expect(() => serverDataImportRoots(env([{ ...valid, path: directory }]), options)).toThrow();
  });
  it.each(['../secret', 'a/../secret', '/etc/passwd', 'C:/secret', 'a\\file', 'a//file', '.env', 'a/.ssh/key', 'a/%2e%2e/file', 'a\0file', 'a/vault/file', 'a/NUL.txt', 'a/file.'])('rejects unsafe relative selection %s', value => {
    expect(() => relativeSelection(value)).toThrow();
  });
  it('retains ordinary relative Unicode and scientific filenames without normalizing unsafe input', () => {
    expect(relativeSelection('Study α/cells.filtered.rds')).toBe('Study α/cells.filtered.rds');
    expect(relativeSelection('', { directory: true })).toBe('');
    expect(() => relativeSelection('')).toThrow();
  });
});
