import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const { startPrivateKernelStream, PRIVATE_KERNEL_STREAM_SOURCE } = require('./privateKernelStream');
const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const containerId = 'a'.repeat(64), filename = 'b'.repeat(64) + '.rds';
const bytes = Buffer.from('isolated scientific bytes');
async function destination() { const directory = await mkdtemp(path.join(os.tmpdir(), 'kernel-stream-')); directories.push(directory); return path.join(directory, 'output'); }
function reader({ chunks = [bytes], ready = true, code = 0, hang = false, ignoreAbort = false, ignoreKill = false, onSpawn } = {}) {
  return (...args) => {
    onSpawn?.(args);
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let finished = false;
    const close = result => { if (finished) return; finished = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', result)); };
    child.kill = () => {if(!ignoreKill)close(1);};
    child.stdin.on('data', command => { if (String(command) === 'finish\n') close(code); else if (String(command) === 'abort\n'&&!ignoreAbort) close(1); });
    setImmediate(() => {
      if (ready) child.stderr.write('READY\n');
      if (!hang) for (const chunk of chunks) child.stdout.write(chunk);
      if (!ready && !hang) close(code);
    });
    return child;
  };
}
describe('bounded private publication stream', () => {
  it('streams bytes to private disk and commits their exact hash only after the explicit finish control', async () => {
    const target = await destination(); let args;
    const stream = await startPrivateKernelStream({ containerId, filename, destination: target, maxBytes: 64,
      spawnImpl: reader({ chunks: [bytes.subarray(0, 3), bytes.subarray(3)], onSpawn: value => { args = value; } }) });
    stream.finish();
    expect(await stream.complete).toEqual({ filePath: target, sizeBytes: bytes.length, checksumSha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    expect(await readFile(target)).toEqual(bytes);
    expect(args[1].slice(0, 5)).toEqual(['exec', '--interactive', '--user', '10001:10001', containerId]);
    expect(PRIVATE_KERNEL_STREAM_SOURCE).toContain('os.O_NOFOLLOW'); expect(PRIVATE_KERNEL_STREAM_SOURCE).toContain('stat.S_ISFIFO');
    expect(PRIVATE_KERNEL_STREAM_SOURCE).toContain('time.monotonic()'); expect(PRIVATE_KERNEL_STREAM_SOURCE).toContain("control!=b'finish\\n'");
  });
  it('rejects malformed identities and limits before starting Docker', async () => {
    let launches = 0;
    for (const change of [{ containerId: 'alias' }, { filename: '../escape.rds' }, { maxBytes: 0 }, { maxBytes: 64 * 1024 ** 3 + 1 }]) {
      await expect(startPrivateKernelStream({ containerId, filename, destination: await destination(), maxBytes: 64, ...change,
        spawnImpl: () => { launches++; } })).rejects.toMatchObject({ code: 'PRIVATE_KERNEL_PUBLICATION_INVALID' });
    }
    expect(launches).toBe(0);
  });
  it('hard-cuts excess bytes and removes the owned disk partial', async () => {
    const target = await destination();
    const stream = await startPrivateKernelStream({ containerId, filename, destination: target, maxBytes: 3, spawnImpl: reader() });
    await expect(stream.complete).rejects.toMatchObject({ code: 'PRIVATE_KERNEL_PUBLICATION_LIMIT' });
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves an existing destination and rejects an unexpected reader response', async () => {
    const target = await destination(); await writeFile(target, 'existing'); let launches = 0;
    await expect(startPrivateKernelStream({ containerId, filename, destination: target, maxBytes: 64,
      spawnImpl: () => { launches++; } })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(launches).toBe(0); expect(await readFile(target, 'utf8')).toBe('existing');
    const fresh = await destination();
    await expect(startPrivateKernelStream({ containerId, filename, destination: fresh, maxBytes: 64,
      spawnImpl: reader({ ready: false, code: 1 }) })).rejects.toMatchObject({ code: 'PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE' });
    await expect(readFile(fresh)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('bounds startup and total transfer time and cancels disconnected saves', async () => {
    const blocked = await destination();
    await expect(startPrivateKernelStream({ containerId, filename, destination: blocked, maxBytes: 64,
      readyTimeoutMs: 10, spawnImpl: reader({ ready: false, hang: true }) })).rejects.toMatchObject({ code: 'PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE' });
    const expired = await destination();
    const timed = await startPrivateKernelStream({ containerId, filename, destination: expired, maxBytes: 64,
      timeoutMs: 10, spawnImpl: reader({ hang: true }) });
    await expect(timed.complete).rejects.toMatchObject({ code: 'PRIVATE_KERNEL_TRANSFER_TIMEOUT' });
    const target = await destination(), controller = new AbortController();
    const stream = await startPrivateKernelStream({ containerId, filename, destination: target, maxBytes: 64,
      signal: controller.signal, spawnImpl: reader({ hang: true }) }); controller.abort();
    await expect(stream.complete).rejects.toMatchObject({ code: 'PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE' });
    for (const file of [blocked, expired, target]) await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('waits for actual reader exit after an ignored abort and rejects unconfirmed cleanup',async()=>{
    const target=await destination();let child;
    const spawn=reader({hang:true,ignoreAbort:true});
    const stream=await startPrivateKernelStream({containerId,filename,destination:target,maxBytes:64,cancelGraceMs:10,
      spawnImpl:(...args)=>{child=spawn(...args);return child;}});
    let closed=false;child.once('close',()=>{closed=true;});stream.cancel();
    await expect(stream.complete).rejects.toMatchObject({code:'PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE'});expect(closed).toBe(true);
    const unconfirmed=await startPrivateKernelStream({containerId,filename,destination:await destination(),maxBytes:64,cancelGraceMs:5,closeTimeoutMs:20,
      spawnImpl:reader({hang:true,ignoreAbort:true,ignoreKill:true})});unconfirmed.cancel();
    await expect(unconfirmed.complete).rejects.toMatchObject({code:'PRIVATE_KERNEL_STREAM_CLEANUP_UNCONFIRMED'});
    await expect(startPrivateKernelStream({containerId,filename,destination:await destination(),maxBytes:64,readyTimeoutMs:5,cancelGraceMs:5,closeTimeoutMs:20,
      spawnImpl:reader({ready:false,hang:true,ignoreAbort:true,ignoreKill:true})})).rejects.toMatchObject({code:'PRIVATE_KERNEL_STREAM_CLEANUP_UNCONFIRMED'});
  });
});
