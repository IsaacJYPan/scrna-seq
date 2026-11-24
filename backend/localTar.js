'use strict';

// Arguments for running the local `tar` on an archive path.
//
// GNU tar reads an archive name containing ':' as host:path, so a Windows path
// such as C:\work\out.tar.gz is taken for a remote host (Git for Windows puts
// GNU tar first on PATH). bsdtar has no --force-local. Running tar in the
// archive's own directory and naming the file without a directory works with
// both, on every platform. The -C directory is given relative to that working
// directory for the same reason (MSYS GNU tar also mangles backslashed absolute
// paths), or as an absolute forward-slash path when it is on another drive.

const path = require('path');

function directoryArg(cwd, directory) {
  const absolute = path.resolve(directory);
  const relative = path.relative(cwd, absolute);
  if (!relative) return '.';
  if (!path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  return absolute.split(path.sep).join('/');
}

function localTarCommand(mode, archivePath, directory, extraArgs = []) {
  if (!['create', 'extract'].includes(mode)) throw new Error(`Unknown tar mode: ${mode}`);
  const archive = path.resolve(archivePath);
  const cwd = path.dirname(archive);
  const target = directoryArg(cwd, directory);
  const args = mode === 'create'
    ? ['-czf', path.basename(archive), '-C', target, '.', ...extraArgs]
    : ['-xzf', path.basename(archive), '-C', target, ...extraArgs];
  return { args, cwd };
}

module.exports = { localTarCommand };
