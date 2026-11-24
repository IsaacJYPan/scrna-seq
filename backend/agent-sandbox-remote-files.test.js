import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  normalizeRemoteRoots, normalizeRelativePath, normalizeRemoteInputs, createRemoteFileBrowser,
} = require('./agentSandbox/remoteFiles');
const { shellQuote } = require('./executors/slurm');

// The same transport shape the Slurm executor uses, run on this machine.
// Commands go through a shell with every argument single-quoted, exactly as
// the SSH transport sends them, so quoting mistakes would show up here.
const commands = [];
const transport = {
  exec: async (argv) => {
    commands.push(argv);
    const result = spawnSync('sh', ['-c', argv.map(shellQuote).join(' ')], { encoding: 'utf8' });
    if (result.status !== 0) throw Object.assign(new Error('failed'), { code: 'SLURM_COMMAND_FAILED' });
    return result.stdout;
  },
  get: async (remote, local) => fs.promises.copyFile(remote, local),
};

let base;
let root;
const browser = createRemoteFileBrowser({ transport });

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tro-remote-test-'));
  root = { name: 'raw', path: path.join(base, 'lab', 'pbmc') };
  fs.mkdirSync(path.join(root.path, 'filtered'), { recursive: true });
  fs.writeFileSync(path.join(root.path, 'samples.csv'), 'sample,condition\nA,ctrl\nB,stim\n');
  fs.writeFileSync(path.join(root.path, 'filtered', 'matrix.h5'), Buffer.from([0x89, 0x48, 0x44, 0x46, 0, 1, 2]));
  fs.writeFileSync(path.join(root.path, "sample sheet.txt"), 'quoted name\n');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'outside the root\n');
  fs.symlinkSync(path.join(base, 'secret.txt'), path.join(root.path, 'escape.txt'));
  fs.symlinkSync(base, path.join(root.path, 'up'));
  fs.symlinkSync(path.join(root.path, 'samples.csv'), path.join(root.path, 'inside-link.csv'));
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe('remote folder definitions', () => {
  it('accepts named absolute folders and refuses risky ones', () => {
    expect(normalizeRemoteRoots([{ name: 'raw', path: '/scratch/lab/pbmc/' }])).toEqual([{ name: 'raw', path: '/scratch/lab/pbmc' }]);
    for (const bad of ['/', '/scratch', 'scratch/lab', '/scratch/../etc', '/scratch/lab/$(id)', "/scratch/lab'x"]) {
      expect(() => normalizeRemoteRoots([{ name: 'raw', path: bad }]), bad).toThrowError();
    }
    expect(() => normalizeRemoteRoots([{ name: 'Raw!', path: '/a/b' }])).toThrowError(/names/);
    expect(() => normalizeRemoteRoots([{ name: 'a', path: '/a/b' }, { name: 'a', path: '/a/c' }])).toThrowError(/twice/);
  });

  it('accepts only relative paths without traversal', () => {
    expect(normalizeRelativePath('filtered//matrix.h5')).toBe('filtered/matrix.h5');
    for (const bad of ['/etc/passwd', '../x', 'a/../../b', 'a/./b', 'a\\b', '$(id)', "it's"]) {
      expect(() => normalizeRelativePath(bad), bad).toThrowError();
    }
  });

  it('remote inputs must name files in the sandbox folders', () => {
    expect(normalizeRemoteInputs([{ root: 'raw', path: 'filtered/matrix.h5' }], [root])).toEqual([{ root: 'raw', path: 'filtered/matrix.h5' }]);
    expect(() => normalizeRemoteInputs([{ root: 'other', path: 'x' }], [root])).toThrowError(/not part/);
    expect(() => normalizeRemoteInputs([{ root: 'raw', path: '' }], [root])).toThrowError(/file/);
  });
});

describe('remote file browser', () => {
  it('lists a folder with types and sizes', async () => {
    const listing = await browser.list(root, '');
    const byName = Object.fromEntries(listing.entries.map((entry) => [entry.name, entry]));
    expect(listing.entries[0].type).toBe('directory');
    expect(byName['samples.csv']).toMatchObject({ type: 'file', sizeBytes: 31, kind: 'text', path: 'samples.csv' });
    expect(byName['escape.txt'].type).toBe('link');
    expect((await browser.list(root, 'filtered')).entries.map((entry) => entry.path)).toEqual(['filtered/matrix.h5']);
  });

  it('reads text in bounded pages, including awkward file names', async () => {
    const file = await browser.read(root, 'samples.csv');
    expect(file.text).toBe('sample,condition\nA,ctrl\nB,stim\n');
    expect(file.truncated).toBe(false);
    const page = await browser.read(root, 'samples.csv', { offset: 17 });
    expect(page.text).toBe('A,ctrl\nB,stim\n');
    expect((await browser.read(root, "sample sheet.txt")).text).toBe('quoted name\n');
    expect(await browser.read(root, 'filtered/matrix.h5')).toMatchObject({ kind: 'binary', sizeBytes: 7 });
    expect((await browser.read(root, 'inside-link.csv')).text).toContain('sample');
  });

  it('refuses links that lead outside the folder', async () => {
    await expect(browser.read(root, 'escape.txt')).rejects.toMatchObject({ code: 'REMOTE_PATH_OUTSIDE_ROOT' });
    await expect(browser.list(root, 'up')).rejects.toMatchObject({ code: 'REMOTE_PATH_OUTSIDE_ROOT' });
    await expect(browser.read(root, 'up/secret.txt')).rejects.toMatchObject({ code: 'REMOTE_PATH_OUTSIDE_ROOT' });
    await expect(browser.read(root, 'missing.csv')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stages a verified read-only copy', async () => {
    const destination = path.join(base, 'staged.h5');
    const staged = await browser.stage(root, 'filtered/matrix.h5', destination);
    expect(staged).toMatchObject({ root: 'raw', path: 'filtered/matrix.h5', sizeBytes: 7 });
    expect(staged.checksumSha256).toBe(require('crypto').createHash('sha256').update(fs.readFileSync(destination)).digest('hex'));
    expect(fs.statSync(destination).mode & 0o222).toBe(0);
    await expect(browser.stage(root, 'escape.txt', path.join(base, 'x'))).rejects.toMatchObject({ code: 'REMOTE_PATH_OUTSIDE_ROOT' });
  });

  it('uses only the fixed command set', () => {
    const used = new Set(commands.map((argv) => argv[0]));
    for (const command of used) expect(['realpath', 'stat', 'find', 'dd', 'cp', 'chmod', 'sha256sum']).toContain(command);
  });
});
