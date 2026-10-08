'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const storage = require('./storage');

const MAX_PRIVATE_KERNEL_EXPORT_BYTES = 20 * 1024 * 1024;
const PUBLICATION_ID = /^pub_[0-9a-f]{24}$/;
const GENERATION = /^[0-9a-f]{64}$/;
function failure(code, message) { return Object.assign(new Error(message), { code, publicSafeHandlerError: true }); }
function validateSourceOptions({ publicationId, generation, type, binding } = {}) {
  if (!PUBLICATION_ID.test(publicationId || '') || !GENERATION.test(generation || '')
      || !['object', 'table'].includes(type) || typeof binding !== 'string' || !binding
      || Buffer.byteLength(binding) > 256 || /[\p{Cc}]/u.test(binding)) {
    throw failure('PRIVATE_KERNEL_PUBLICATION_INVALID', 'Select a named R object or data frame to save.');
  }
  return { publicationId, generation, type, binding };
}
function exportFilename(spec) {
  const value = validateSourceOptions(spec);
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex') + (value.type === 'object' ? '.rds' : '.csv');
}
function generatePrivateKernelExportSource(spec) {
  const value = validateSourceOptions(spec), filename = exportFilename(value);
  const serialize = value.type === 'object'
    ? 'base::saveRDS(value, file = destination, compress = "gzip", version = 3L)'
    : 'if (!base::is.data.frame(value)) base::stop("Table publication requires a data frame."); utils::write.csv(value, file = destination, row.names = FALSE, fileEncoding = "UTF-8", na = "NA")';
  return `base::local({\n  value <- base::get(${JSON.stringify(value.binding)}, envir = base::globalenv(), inherits = FALSE)\n  destination <- ${JSON.stringify('/work/export/' + filename)}\n  ${serialize}\n  size <- base::file.info(destination)$size\n  if (base::is.na(size) || size > ${MAX_PRIVATE_KERNEL_EXPORT_BYTES}L) { base::unlink(destination); base::stop("Saved output exceeds the 20 MiB publication limit.") }\n  base::invisible(NULL)\n})`;
}
function validatePrivateKernelExportRequest(spec, { projectId, generation } = {}) {
  const value = validateSourceOptions({ ...spec, generation });
  if (!storage.isProjectStorageKey(spec.internalStorageKey, { projectId, kind: 'artifacts' })
      || spec.source !== generatePrivateKernelExportSource(value)) {
    throw failure('PRIVATE_KERNEL_PUBLICATION_INVALID', 'The saved-output command or destination is invalid.');
  }
  return { ...value, executionId: spec.executionId, order: spec.order, source: spec.source,
    internalStorageKey: spec.internalStorageKey, filename: exportFilename(value) };
}

// Executed by the container's nonroot Python process. Open every container path
// component by descriptor, never following a symlink or accepting an R path.
const EXTRACT_SOURCE = `import os,stat,sys\nroot=os.open('/work',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\ndirectory=os.open('export',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)\nhandle=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)\nentry=os.fstat(handle)\nexpected=int(sys.argv[2])\nif not stat.S_ISREG(entry.st_mode) or entry.st_nlink!=1 or entry.st_size!=expected or expected<0 or expected>${MAX_PRIVATE_KERNEL_EXPORT_BYTES}: raise ValueError('Invalid output')\ntotal=0\nwhile True:\n chunk=os.read(handle,65536)\n if not chunk: break\n total+=len(chunk)\n if total>expected: raise ValueError('Changed output')\n sys.stdout.buffer.write(chunk)\nif total!=expected: raise ValueError('Changed output')\nsys.stdout.buffer.flush()\ncurrent=os.stat(sys.argv[1],dir_fd=directory,follow_symlinks=False)\nif current.st_ino!=entry.st_ino or current.st_dev!=entry.st_dev: raise ValueError('Changed output')\nos.unlink(sys.argv[1],dir_fd=directory)\nos.close(handle)\nos.close(directory)\nos.close(root)\n`;
async function extractPrivateKernelFile({ containerId, filename, destination, expected, spawnImpl = spawn, signal, timeoutMs = 30000 } = {}) {
  if (!GENERATION.test(containerId || '') || !/^[0-9a-f]{64}\.(rds|csv)$/.test(filename || '')
      || !Number.isSafeInteger(expected?.sizeBytes) || expected.sizeBytes < 0 || expected.sizeBytes > MAX_PRIVATE_KERNEL_EXPORT_BYTES
      || !GENERATION.test(expected?.checksumSha256 || '')) {
    throw failure('PRIVATE_KERNEL_PUBLICATION_INVALID', 'The isolated output evidence is invalid.');
  }
  if (signal?.aborted) throw failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The saved output was interrupted.');
  // Opening exclusively before starting Docker means cleanup owns this exact
  // temporary file and cannot remove an already existing destination.
  const handle = await fs.promises.open(destination, 'wx', 0o600);
  let child, timer, aborted = false, completed = false, sizeBytes = 0;
  const hash = crypto.createHash('sha256');
  const guard = new Transform({ transform(chunk, _encoding, done) {
    sizeBytes += chunk.length;
    if (sizeBytes > expected.sizeBytes || sizeBytes > MAX_PRIVATE_KERNEL_EXPORT_BYTES) {
      done(failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The isolated output exceeds its declared size.'));
    } else { hash.update(chunk); done(null, chunk); }
  } });
  const abort = () => { aborted = true; child?.kill('SIGKILL'); guard.destroy(failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The saved output was interrupted.')); };
  try {
    child = spawnImpl('docker', ['exec', '--user', '10001:10001', containerId, 'python3', '-c', EXTRACT_SOURCE, filename, String(expected.sizeBytes)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', () => {});
    const closed = new Promise((resolve, reject) => {
      child.once('error', () => { guard.destroy(); reject(failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The isolated output could not be read.')); });
      child.once('close', code => code === 0 && !aborted ? resolve() : reject(failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The isolated output could not be read.')));
    });
    timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const output = new Writable({ write(chunk, _encoding, done) { handle.writeFile(chunk).then(() => done(), done); } });
    await Promise.all([closed, pipeline(child.stdout, guard, output)]);
    const checksumSha256 = hash.digest('hex');
    if (sizeBytes !== expected.sizeBytes || checksumSha256 !== expected.checksumSha256) {
      throw failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The isolated output changed before it could be saved.');
    }
    await handle.sync();
    completed = true;
    return { filePath: destination, checksumSha256, sizeBytes };
  } catch (error) {
    child?.kill('SIGKILL');
    if (error.publicSafeHandlerError) throw error;
    throw failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The isolated output could not be read.');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); await handle.close();
    if (!completed) await fs.promises.unlink(destination).catch(() => {});
  }
}

module.exports = { MAX_PRIVATE_KERNEL_EXPORT_BYTES, PRIVATE_KERNEL_PUBLICATION_ID_RE: PUBLICATION_ID,
  exportFilename, generatePrivateKernelExportSource, validatePrivateKernelExportRequest, extractPrivateKernelFile };
