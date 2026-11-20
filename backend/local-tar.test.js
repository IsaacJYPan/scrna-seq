import { describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { localTarCommand } = require('./localTar');

describe('localTarCommand', () => {
  it('names the archive without a directory so GNU tar never reads a drive letter as a host', () => {
    const root = path.resolve(os.tmpdir(), 'work');
    const { args, cwd } = localTarCommand('create', path.join(root, 'out.tar.gz'), path.join(root, 'output'));
    expect(cwd).toBe(root);
    expect(args).toEqual(['-czf', 'out.tar.gz', '-C', 'output', '.']);
    expect(localTarCommand('extract', path.join(root, 'in.tar.gz'), path.join(root, 'x', 'y'), ['--no-same-owner']).args)
      .toEqual(['-xzf', 'in.tar.gz', '-C', 'x/y', '--no-same-owner']);
    expect(localTarCommand('create', path.join(root, 'out.tar.gz'), root).args[3]).toBe('.');
    expect(localTarCommand('create', path.join(root, 'a', 'out.tar.gz'), path.join(root, 'b')).args[3]).toBe('../b');
    expect(() => localTarCommand('list', 'a.tar.gz', '.')).toThrow(/Unknown tar mode/);
  });

  it('round-trips files through the system tar from absolute paths', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'local-tar-'));
    try {
      const source = path.join(base, 'source');
      const restored = path.join(base, 'restored');
      fs.mkdirSync(source);
      fs.mkdirSync(restored);
      fs.writeFileSync(path.join(source, 'clusters.csv'), 'cluster,n\n0,40\n');
      const archive = path.join(base, 'bundle.tar.gz');
      const create = localTarCommand('create', archive, source);
      execFileSync('tar', create.args, { cwd: create.cwd });
      const extract = localTarCommand('extract', archive, restored);
      execFileSync('tar', extract.args, { cwd: extract.cwd });
      expect(fs.readFileSync(path.join(restored, 'clusters.csv'), 'utf8')).toBe('cluster,n\n0,40\n');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
