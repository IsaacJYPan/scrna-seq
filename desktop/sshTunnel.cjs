'use strict';

const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { systemExecutable, classifySshFailure } = require('./sshConnection.cjs');
const { diagnosticStage, annotateStage } = require('./sshRouting.cjs');
function failure(code, message) { return Object.assign(new Error(message), { code }); }
const ownedTunnels = new Set();
function stopOwnedProcess(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    const terminator = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    terminator.on('error', () => child.kill()); terminator.on('exit', code => { if (code !== 0) child.kill(); });
  } else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
}
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function ownsLocalListener({ port, pid }) {
  if (process.platform !== 'win32') return true;
  // Windows socket reuse can allow a second listener on the same address.
  // Never send HTTPS to an allocated port owned by an unrelated process.
  const filename = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'netstat.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(filename, ['-ano', '-p', 'TCP'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '', limited = false;
    const timer = setTimeout(() => { limited = true; child.kill(); }, 3000);
    child.stdout.on('data', chunk => { if (text.length + chunk.length > 4 * 1024 * 1024) { limited = true; child.kill(); } else text += chunk.toString('utf8'); });
    child.once('error', () => { clearTimeout(timer); reject(failure('SSH_PORT_VERIFICATION_FAILED', 'The native tunnel listener could not be checked. Review system networking access and retry.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (limited || code !== 0) return reject(failure('SSH_PORT_VERIFICATION_FAILED', 'The native tunnel listener could not be checked. Review system networking access and retry.'));
      const listeners = text.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 5 && parts[0] === 'TCP'
        && ['127.0.0.1:' + port, '0.0.0.0:' + port, '[::]:' + port].includes(parts[1])
        && ['0.0.0.0:0', '[::]:0'].includes(parts[2]));
      resolve(listeners.some(parts => parts[1] === '127.0.0.1:' + port && Number(parts[4]) === pid)
        && listeners.every(parts => Number(parts[4]) === pid));
    });
  });
}
function transportFailure(stderr, lease) {
  if (/bind .*Address already in use|cannot listen to port|Could not request local forwarding/i.test(stderr)) return failure('SSH_LOCAL_PORT_CONFLICT', 'The allocated local tunnel port became unavailable. Retry the connection.');
  if (/open failed: administratively prohibited|open failed: connect failed|forwarding disabled/i.test(stderr)) return failure('SSH_FORWARD_FAILED', 'The SSH server could not forward its HTTPS service. Check the loopback service port and its SSH forwarding policy.');
  const error = classifySshFailure({ stderr });
  const stage = diagnosticStage(stderr, lease.configuration.routeNodes || []);
  return stage ? annotateStage(error, stage.node.profile, stage.index) : error;
}
async function createSshTunnel(lease, { signal, onLost = () => {}, spawnImpl = spawn, allocatePort = availablePort, verifyListener = ownsLocalListener, startupMs = 12000 } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw failure('SSH_CANCELLED', 'SSH connection was canceled.');
    const port = await allocatePort();
    try {
      return await new Promise((resolve, reject) => {
        const host = lease.profile.ssh.remoteHost.replace(/^\[|\]$/g, '');
        const args = [...lease.args, '-N', '-T', '-v', '-oClearAllForwardings=no', '-oExitOnForwardFailure=yes',
          '-oServerAliveInterval=5', '-oServerAliveCountMax=2', '-L', `127.0.0.1:${port}:[${host}]:${lease.profile.ssh.remotePort}`,
          lease.profile.ssh.host.replace(/^\[|\]$/g, '')];
        const child = spawnImpl(systemExecutable('ssh'), args, { shell: false, windowsHide: true,
          detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
        ownedTunnels.add(child);
        let stderr = '', ready = false, checking = false, closed = false, intentional = false, authenticated = false, listening = false;
        let size = 0, rateReset = Date.now();
        const stopped = new Promise(done => child.once('close', done));
        const cleanupStartup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
        function dispose() { intentional = true; cleanupStartup(); stopOwnedProcess(child); return stopped; }
        function fail(error) {
          if (closed || intentional) return;
          const wasReady = ready; dispose();
          if (wasReady) onLost(error); else reject(error);
        }
        const cancel = () => fail(failure('SSH_CANCELLED', 'SSH connection was canceled.'));
        signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => fail(failure('SSH_TIMEOUT', 'Opening the SSH tunnel timed out. Check the SSH host and forwarding policy, then retry.')), startupMs);
        child.stderr.on('data', chunk => {
          if (Date.now() - rateReset > 10000) { size = 0; rateReset = Date.now(); }
          size += chunk.length;
          if (size > 256 * 1024) return fail(failure('SSH_RESPONSE_LIMIT', 'The SSH tunnel produced excessive diagnostic output. Review its native configuration.'));
          stderr = (stderr + chunk.toString('utf8')).slice(-65536);
          authenticated ||= /Authenticated to /i.test(stderr);
          listening ||= new RegExp('Local forwarding listening on 127\\.0\\.0\\.1 port ' + port + '(?:\\.|\\s)').test(stderr);
          if (/bind .*Address already in use|cannot listen to port|Could not request local forwarding|open failed: administratively prohibited|open failed: connect failed/i.test(stderr)) return fail(transportFailure(stderr, lease));
          if (!ready && !checking && authenticated && listening) {
            checking = true;
            void verifyListener({ port, pid: child.pid }).then(owned => {
              if (closed || intentional) return;
              if (!owned) return fail(failure('SSH_LOCAL_PORT_CONFLICT', 'The allocated local tunnel port is also owned by another process. Retry the connection.'));
              ready = true; cleanupStartup();
              resolve({ port, pid: child.pid, connectedAt: new Date().toISOString(), dispose });
            }).catch(fail);
          }
        });
        child.once('error', error => fail(failure(error.code === 'ENOENT' ? 'SSH_NOT_INSTALLED' : 'SSH_CLIENT_FAILED', 'The system SSH client could not start. Check the native OpenSSH installation.')));
        child.once('close', () => {
          ownedTunnels.delete(child);
          closed = true; cleanupStartup();
          if (!intentional) { const error = stderr ? transportFailure(stderr, lease) : failure('SSH_TUNNEL_LOST', 'The SSH tunnel disconnected. Reconnect through execution target settings.'); if (ready) onLost(error); else reject(error); }
        });
      });
    } catch (error) { if (error.code !== 'SSH_LOCAL_PORT_CONFLICT' || attempt === 2) throw error; }
  }
}
async function createHttpsConnectProxy({ endpoint, forwardPort, maxConnections = 32, connectTimeoutMs = 5000 }) {
  const expected = new URL(endpoint);
  if (expected.protocol !== 'https:') throw new Error('A HTTPS service is required.');
  const authority = expected.hostname.toLowerCase() + ':' + (expected.port || '443');
  const sockets = new Set(); let disposed = false;
  const server = net.createServer(socket => {
    if (disposed || sockets.size >= maxConnections * 2 || socket.remoteAddress !== '127.0.0.1') return socket.destroy();
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(connectTimeoutMs, () => socket.destroy());
    let headers = Buffer.alloc(0);
    function reject(status) { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
    function receive(chunk) {
      headers = Buffer.concat([headers, chunk]);
      if (headers.length > 16384) { socket.off('data', receive); reject('431 Request Header Fields Too Large'); return; }
      const end = headers.indexOf('\r\n\r\n'); if (end < 0) return;
      socket.off('data', receive); socket.pause();
      const text = headers.subarray(0, end).toString('latin1');
      const request = /^CONNECT ([^\s]+) HTTP\/1\.[01]$/.exec(text.split('\r\n')[0]);
      if (!request) { reject('405 Method Not Allowed'); return; }
      if (request[1].toLowerCase() !== authority || /\r(?!\n)|\n(?![\s\S])/u.test(text) || text.split('\r\n').slice(1).some(line => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[^\0\r\n]*$/.test(line))) { reject('403 Forbidden'); return; }
      const upstream = net.connect({ host: '127.0.0.1', port: forwardPort });
      sockets.add(upstream); upstream.once('close', () => { sockets.delete(upstream); socket.destroy(); });
      socket.once('close', () => upstream.destroy());
      upstream.setTimeout(connectTimeoutMs, () => upstream.destroy());
      upstream.once('error', () => { if (!socket.destroyed) reject('502 Bad Gateway'); });
      upstream.once('connect', () => {
        upstream.setTimeout(0); socket.setTimeout(0);
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const tail = headers.subarray(end + 4); if (tail.length) upstream.write(tail);
        socket.pipe(upstream); upstream.pipe(socket); socket.resume();
      });
    }
    socket.on('data', receive);
  });
  server.maxConnections = maxConnections;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
  return { port: server.address().port, dispose() {
    if (disposed) return; disposed = true; for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(resolve));
  } };
}
module.exports = { createSshTunnel, createHttpsConnectProxy, availablePort, transportFailure, ownsLocalListener,
  disposeOwnedTunnels() { for (const child of ownedTunnels) stopOwnedProcess(child); } };
