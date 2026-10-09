'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function failure(code, message) { return Object.assign(new Error(message), { code, publicSafeHandlerError: true }); }

// The FIFO contains at most the kernel's pipe buffer. Scientific bytes flow to
// the broker's private disk, never to an unbounded writable container mount.
// stdin is an independent fixed control channel; losing it ends the reader.
const STREAM_SOURCE = `import os,stat,sys,select,time\nroot=os.open('/work',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\ndirectory=os.open('export',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)\nfilename=sys.argv[1]\nmaximum=int(sys.argv[2])\ndeadline=time.monotonic()+float(sys.argv[3])\nhandle=None\nentry=None\ntry:\n os.mkfifo(filename,0o600,dir_fd=directory)\n entry=os.stat(filename,dir_fd=directory,follow_symlinks=False)\n handle=os.open(filename,os.O_RDWR|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=directory)\n opened=os.fstat(handle)\n if not stat.S_ISFIFO(opened.st_mode) or opened.st_nlink!=1 or opened.st_ino!=entry.st_ino or opened.st_dev!=entry.st_dev: raise ValueError('Invalid stream')\n sys.stderr.write('READY\\n');sys.stderr.flush()\n total=0\n control=b''\n finished=False\n while True:\n  remaining=deadline-time.monotonic()\n  if remaining<=0: sys.stderr.write('TIMEOUT\\n');sys.stderr.flush();raise TimeoutError('Stream expired')\n  readable,_,_=select.select([handle] if finished else [handle,sys.stdin],[],[],min(remaining,0.2))\n  if not finished and sys.stdin in readable:\n   chunk=os.read(sys.stdin.fileno(),128)\n   if not chunk: raise ValueError('Control disconnected')\n   control+=chunk\n   if len(control)>128: raise ValueError('Invalid control')\n   if b'\\n' in control:\n    if control!=b'finish\\n': raise ValueError('Stream aborted')\n    finished=True\n  if handle in readable or finished:\n   try: chunk=os.read(handle,65536)\n   except BlockingIOError: chunk=None\n   if chunk:\n    total+=len(chunk)\n    if total>maximum: sys.stderr.write('LIMIT\\n');sys.stderr.flush();raise ValueError('Stream exceeds reservation')\n    sys.stdout.buffer.write(chunk);sys.stdout.buffer.flush()\n   elif finished: break\n if total<1: raise ValueError('Empty stream')\n current=os.stat(filename,dir_fd=directory,follow_symlinks=False)\n if current.st_ino!=entry.st_ino or current.st_dev!=entry.st_dev or not stat.S_ISFIFO(current.st_mode): raise ValueError('Changed stream')\nfinally:\n if handle is not None: os.close(handle)\n if entry is not None:\n  try:\n   current=os.stat(filename,dir_fd=directory,follow_symlinks=False)\n   if current.st_ino==entry.st_ino and current.st_dev==entry.st_dev and stat.S_ISFIFO(current.st_mode): os.unlink(filename,dir_fd=directory)\n  except FileNotFoundError: pass\n os.close(directory);os.close(root)\n`;

async function startPrivateKernelStream({ containerId, filename, destination, maxBytes, spawnImpl = spawn,
  signal, timeoutMs = 900000, readyTimeoutMs = 15000, cancelGraceMs = 250, closeTimeoutMs = 3000 } = {}) {
  if (!/^[0-9a-f]{64}$/.test(containerId || '') || !/^[0-9a-f]{64}\.(rds|csv)$/.test(filename || '')
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 ** 3
      || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) {
    throw failure('PRIVATE_KERNEL_PUBLICATION_INVALID', 'The isolated output stream reservation is invalid.');
  }
  if (signal?.aborted) throw failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The saved output was interrupted.');
  const handle = await fs.promises.open(destination, 'wx', 0o600);
  const owned = await handle.stat({ bigint: true });
  let child, timer, readyTimer, killTimer, completed = false, canceled = false, didClose = false, readied = false, sizeBytes = 0, streamError;
  let resolveExited;
  const exited = new Promise(resolve => { resolveExited = resolve; });
  const hash = crypto.createHash('sha256');
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const guard = new Transform({ transform(chunk, _encoding, done) {
    sizeBytes += chunk.length;
    if (sizeBytes > maxBytes) {
      streamError = failure('PRIVATE_KERNEL_PUBLICATION_LIMIT', 'The saved output exceeds its reserved byte limit.');
      done(streamError);
    } else { hash.update(chunk); done(null, chunk); }
  } });
  const cancel = () => {
    if (completed || canceled) return;
    canceled = true;
    streamError ||= failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The saved output was interrupted.');
    try { child?.stdin.end('abort\n'); } catch { /* Closed control is already terminal. */ }
    rejectReady(streamError); guard.destroy(streamError);
    if(child&&!didClose)killTimer=setTimeout(()=>{if(!didClose)child.kill('SIGKILL');},cancelGraceMs);
  };
  let complete;
  try {
    child = spawnImpl('docker', ['exec', '--interactive', '--user', '10001:10001', containerId, 'python3', '-c', STREAM_SOURCE,
      filename, String(maxBytes), String(timeoutMs / 1000)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let readyBytes = '';
    child.stderr.on('data', chunk => {
      if (readyBytes.length >= 512) return;
      readyBytes = (readyBytes + chunk.toString('utf8')).slice(0, 512);
      if (readyBytes.startsWith('READY\n')) { readied=true;clearTimeout(readyTimer); resolveReady(); }
      if (readyBytes.includes('\nLIMIT\n')) streamError = failure('PRIVATE_KERNEL_PUBLICATION_LIMIT', 'The saved output exceeds its reserved byte limit.');
      if (readyBytes.includes('\nTIMEOUT\n')) streamError = failure('PRIVATE_KERNEL_TRANSFER_TIMEOUT', 'The saved-output transfer exceeded its time limit.');
    });
    child.stdin.on('error', () => cancel());
    const closed = new Promise((resolve, reject) => {
      child.once('error', () => { didClose=true;resolveExited();cancel();reject(streamError); });
      child.once('close', code => {
        didClose=true;resolveExited();
        if (code === 0 && !canceled&&readied) resolve();
        else {
          streamError ||= failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The isolated output stream could not be read.');
          rejectReady(streamError); guard.destroy(streamError); reject(streamError);
        }
      });
    });
    timer = setTimeout(() => { streamError ||= failure('PRIVATE_KERNEL_TRANSFER_TIMEOUT', 'The saved-output transfer exceeded its time limit.'); cancel(); child.kill('SIGKILL'); }, timeoutMs);
    readyTimer = setTimeout(() => { cancel(); child.kill('SIGKILL'); }, Math.min(timeoutMs, readyTimeoutMs));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const output = new Writable({ write(chunk, _encoding, done) { handle.writeFile(chunk).then(() => done(), done); } });
    complete = (async () => {
      try {
        await Promise.all([closed, pipeline(child.stdout, guard, output)]);
        if (sizeBytes < 1 || canceled) throw streamError || failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The isolated output stream is empty.');
        await handle.sync(); completed = true;
        return { filePath: destination, sizeBytes, checksumSha256: hash.digest('hex') };
      } catch (error) {
        cancel();
        let deadline;
        const confirmed=didClose||await Promise.race([exited.then(()=>true),new Promise(resolve=>{deadline=setTimeout(()=>resolve(false),closeTimeoutMs);})]);
        clearTimeout(deadline);
        if(!confirmed) {
          streamError=failure('PRIVATE_KERNEL_STREAM_CLEANUP_UNCONFIRMED','The output reader could not confirm cleanup. Stop this private R session before starting another.');
          throw streamError;
        }
        throw error.publicSafeHandlerError ? error : failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The isolated output stream could not be saved.');
      } finally {
        clearTimeout(timer); clearTimeout(readyTimer);clearTimeout(killTimer); signal?.removeEventListener('abort', cancel); await handle.close();
        if (!completed) {
          const current = await fs.promises.lstat(destination, { bigint: true }).catch(() => null);
          if (current?.dev === owned.dev && current?.ino === owned.ino) await fs.promises.unlink(destination).catch(() => {});
        }
      }
    })();
    // A quota failure can precede R's terminal reply. Retain the rejection until
    // that reply is inspected without emitting an unhandled promise rejection.
    complete.catch(() => {});
    await ready;
    return { complete, cancel, finish() { if (!canceled) child.stdin.end('finish\n'); }, get error() { return streamError; } };
  } catch (error) {
    cancel();
    if (complete) await complete.catch(() => {});
    else { clearTimeout(timer); clearTimeout(readyTimer); await handle.close(); await fs.promises.unlink(destination).catch(() => {}); }
    if(streamError?.code==='PRIVATE_KERNEL_STREAM_CLEANUP_UNCONFIRMED')throw streamError;
    throw error.publicSafeHandlerError ? error : failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE', 'The isolated output stream could not start.');
  }
}

module.exports = { startPrivateKernelStream, PRIVATE_KERNEL_STREAM_SOURCE: STREAM_SOURCE };
