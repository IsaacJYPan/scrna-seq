'use strict';

// Remote data roots for agent sandboxes.
//
// A person may pin up to five named folders on the cluster (the Slurm SSH
// target) to a sandbox when creating it. The agent can then list and read
// files inside those folders, and stage them read-only into a cluster sandbox
// run, only through the automation API (and so through the MCP tools). The
// agent never receives a shell, an SSH key, or a path outside the roots:
//
// - Paths are relative to a named root and match a fixed character set with no
//   "." or ".." segments; absolute paths are refused before any remote call.
// - The server resolves every path with `realpath -e` on the cluster and
//   accepts it only when the real path is the root's real path or inside it,
//   so symbolic links cannot lead out of a root.
// - Only a fixed command set is used (realpath, stat, find, dd, cp,
//   sha256sum, chmod), each argument single-quoted by the transport; no
//   caller text is interpreted by the remote shell.
// - Listings, reads and staged copies are bounded and audited by the caller.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { codedError } = require('../codedError');

const MAX_ROOTS = 5;
const MAX_REMOTE_INPUTS = 5;
const ROOT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ABSOLUTE = /^\/[A-Za-z0-9_.@+=,-]+(\/[A-Za-z0-9_.@+=,-]+)+\/?$/;
const SEGMENT = /^[A-Za-z0-9_@+=,-][A-Za-z0-9_. @+=,-]{0,199}$/;
const MAX_LIST_ENTRIES = 500;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_STAGE_BYTES = 50 * 1024 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['csv', 'tsv', 'txt', 'json', 'md', 'r', 'py', 'log', 'yaml', 'yml', 'tab', 'gtf', 'bed', 'xml', 'html', 'sh']);
const IMAGE_EXTENSIONS = new Map([['png', 'image/png'], ['svg', 'image/svg+xml']]);

function invalid(message) {
  return codedError('INVALID_INPUT', message, 400);
}

function segments(value) {
  return String(value).split('/').filter(Boolean);
}

// A person's root definitions, fixed when the sandbox is created.
function normalizeRemoteRoots(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > MAX_ROOTS) throw invalid(`remoteRoots must list at most ${MAX_ROOTS} folders.`);
  const roots = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid('Each remote root needs a name and a path.');
    const unknown = Object.keys(entry).filter((key) => !['name', 'path'].includes(key));
    if (unknown.length) throw invalid(`Unknown remote root field: ${unknown[0].slice(0, 32)}.`);
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!ROOT_NAME.test(name)) throw invalid('Remote root names use lowercase letters, digits, "-" or "_" (at most 32).');
    if (roots.some((root) => root.name === name)) throw invalid(`Remote root ${name} is listed twice.`);
    const rootPath = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!ABSOLUTE.test(rootPath) || segments(rootPath).some((part) => part === '.' || part === '..')) {
      throw invalid('Remote root paths must be absolute folders at least two levels deep, without "." or "..".');
    }
    roots.push({ name, path: rootPath.replace(/\/+$/, '') });
  }
  return roots;
}

// The agent's path inside a root: "" for the root itself.
function normalizeRelativePath(value) {
  if (value === undefined || value === null || value === '' || value === '.') return '';
  if (typeof value !== 'string' || value.length > 1024) throw invalid('path must be a relative path inside the root.');
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) throw invalid('path must be relative to the root.');
  const parts = value.split('/').filter((part) => part !== '');
  if (parts.length > 32 || parts.some((part) => part === '.' || part === '..' || !SEGMENT.test(part))) {
    throw invalid('path may use letters, digits, spaces and . _ - @ + = , only, with no "." or ".." parts.');
  }
  return parts.join('/');
}

function fileKind(name) {
  const extension = String(name).split('.').pop().toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return { kind: 'image', mimeType: IMAGE_EXTENSIONS.get(extension) };
  if (TEXT_EXTENSIONS.has(extension)) return { kind: 'text', mimeType: 'text/plain' };
  return { kind: 'binary', mimeType: 'application/octet-stream' };
}

function createRemoteFileBrowser({ transport }) {
  if (!transport || typeof transport.exec !== 'function') throw new Error('A cluster transport is required.');

  async function realpath(target) {
    let out;
    try {
      out = await transport.exec(['realpath', '-e', '--', target], { timeoutMs: 30000 });
    } catch {
      throw codedError('NOT_FOUND', 'That path does not exist in the remote folder.', 404);
    }
    const resolved = out.split('\n')[0].trim();
    if (!resolved.startsWith('/')) throw codedError('NOT_FOUND', 'That path does not exist in the remote folder.', 404);
    return resolved;
  }

  // Resolve a relative path against a root and refuse anything that leaves it.
  async function resolve(root, relative) {
    const rel = normalizeRelativePath(relative);
    const rootReal = await realpath(root.path).catch(() => {
      throw codedError('REMOTE_ROOT_UNAVAILABLE', `The remote folder ${root.name} is not available.`, 409);
    });
    if (!rel) return { rel, resolved: rootReal, rootReal };
    const resolved = await realpath(`${root.path}/${rel}`);
    if (resolved !== rootReal && !resolved.startsWith(`${rootReal.replace(/\/$/, '')}/`)) {
      throw codedError('REMOTE_PATH_OUTSIDE_ROOT', 'That path leads outside the remote folder.', 403);
    }
    return { rel, resolved, rootReal };
  }

  async function stat(resolved) {
    const out = await transport.exec(['stat', '-c', '%F|%s', '--', resolved], { timeoutMs: 30000 });
    const [type, size] = out.trim().split('|');
    return { type, sizeBytes: Number(size) };
  }

  async function list(root, relative) {
    const { rel, resolved } = await resolve(root, relative);
    const info = await stat(resolved);
    if (info.type !== 'directory') throw invalid('That path is a file; read it instead of listing it.');
    const out = await transport.exec(
      ['find', resolved, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y|%s|%T@|%f\\n'],
      { timeoutMs: 60000 }
    );
    const entries = [];
    let truncated = false;
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [type, size, mtime, ...rest] = line.split('|');
      const name = rest.join('|');
      // eslint-disable-next-line no-control-regex -- names with control characters are not shown
      if (!name || /[\u0000-\u001f\u007f/]/.test(name)) continue;
      if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; break; }
      entries.push({
        name,
        path: rel ? `${rel}/${name}` : name,
        type: type === 'd' ? 'directory' : type === 'f' ? 'file' : type === 'l' ? 'link' : 'other',
        sizeBytes: type === 'f' ? Number(size) : null,
        modifiedAt: Number.isFinite(Number(mtime)) ? new Date(Number(mtime) * 1000).toISOString() : null,
        ...(type === 'f' ? { kind: fileKind(name).kind } : {}),
      });
    }
    entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
    return { root: root.name, path: rel, entries, truncated };
  }

  async function read(root, relative, { offset = 0 } = {}) {
    const { rel, resolved } = await resolve(root, relative);
    const info = await stat(resolved);
    if (!/regular/.test(info.type)) throw invalid('Only regular files can be read.');
    const kind = fileKind(rel);
    const base = { root: root.name, path: rel, sizeBytes: info.sizeBytes, kind: kind.kind, mimeType: kind.mimeType };
    if (kind.kind === 'binary') {
      return { ...base, note: 'Binary file: stage it into a sandbox run (remoteInputs) to read it with R.' };
    }
    if (kind.kind === 'image') {
      if (info.sizeBytes > MAX_IMAGE_BYTES) throw invalid('Images larger than 2 MiB cannot be previewed.');
      const local = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tro-remote-'));
      try {
        const file = path.join(local, 'preview');
        await transport.get(resolved, file);
        const content = await fs.promises.readFile(file);
        if (content.length > MAX_IMAGE_BYTES) throw invalid('Images larger than 2 MiB cannot be previewed.');
        return { ...base, base64: content.toString('base64') };
      } finally {
        await fs.promises.rm(local, { recursive: true, force: true });
      }
    }
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('offset must be a non-negative integer.');
    // One bounded read; GNU dd counts skip/count in bytes with these flags.
    const out = await transport.exec(
      ['dd', `if=${resolved}`, 'iflag=skip_bytes,count_bytes', `skip=${offset}`, `count=${MAX_TEXT_BYTES}`, 'status=none'],
      { timeoutMs: 60000 }
    );
    const text = Buffer.from(out, 'utf8').subarray(0, MAX_TEXT_BYTES).toString('utf8');
    return { ...base, offset, text, truncated: offset + Buffer.byteLength(text, 'utf8') < info.sizeBytes };
  }

  // Copy one file into a cluster run's input folder; returns its provenance.
  async function stage(root, relative, destination) {
    const { rel, resolved } = await resolve(root, relative);
    const info = await stat(resolved);
    if (!/regular/.test(info.type)) throw invalid(`${root.name}/${rel} is not a regular file.`);
    if (info.sizeBytes > MAX_STAGE_BYTES) throw invalid(`${root.name}/${rel} is larger than the staging limit.`);
    await transport.exec(['cp', '--', resolved, destination], { timeoutMs: 3600000 });
    // The source must still resolve to the same real file after the copy.
    const after = await realpath(resolved);
    if (after !== resolved) throw codedError('REMOTE_PATH_OUTSIDE_ROOT', 'The remote file changed while it was staged.', 409);
    await transport.exec(['chmod', 'a-w', destination], { timeoutMs: 30000 });
    const sum = await transport.exec(['sha256sum', '--', destination], { timeoutMs: 3600000 });
    const checksumSha256 = sum.trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{64}$/.test(checksumSha256)) throw codedError('REMOTE_STAGE_FAILED', 'The staged file could not be verified.', 502);
    return { root: root.name, path: rel, sizeBytes: info.sizeBytes, checksumSha256 };
  }

  return { resolve, list, read, stage };
}

function normalizeRemoteInputs(input, roots) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > MAX_REMOTE_INPUTS) throw invalid(`remoteInputs may list at most ${MAX_REMOTE_INPUTS} files.`);
  const out = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid('Each remote input needs root and path.');
    const unknown = Object.keys(entry).filter((key) => !['root', 'path'].includes(key));
    if (unknown.length) throw invalid(`Unknown remote input field: ${unknown[0].slice(0, 32)}.`);
    if (!roots.some((root) => root.name === entry.root)) {
      throw codedError('STUDY_AMENDMENT_REQUIRED', 'That remote folder is not part of this sandbox.', 409);
    }
    const rel = normalizeRelativePath(entry.path);
    if (!rel) throw invalid('A remote input must name a file inside the folder.');
    if (out.some((item) => item.root === entry.root && item.path === rel)) throw invalid('A remote input is listed twice.');
    out.push({ root: entry.root, path: rel });
  }
  return out;
}

module.exports = {
  MAX_ROOTS, MAX_REMOTE_INPUTS, MAX_TEXT_BYTES,
  normalizeRemoteRoots, normalizeRelativePath, normalizeRemoteInputs, createRemoteFileBrowser, fileKind,
};
