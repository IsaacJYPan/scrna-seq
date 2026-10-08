import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import multer from 'multer';

const servers = [];
const directories = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

describe('security behavior of release dependencies', () => {
  it('does not trust an IPv4 client through a short mapped IPv6 subnet', async () => {
    const app = express();
    app.set('trust proxy', '::ffff:10.0.0.0/8');
    app.get('/', (req, res) => res.json({ ip: req.ip, ips: req.ips }));
    const url = await listen(app);
    const response = await fetch(url, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    expect(await response.json()).toEqual({ ip: '127.0.0.1', ips: [] });

    app.set('trust proxy', '127.0.0.1/32');
    const trusted = await fetch(url, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    expect(await trusted.json()).toEqual({ ip: '203.0.113.7', ips: ['203.0.113.7'] });
  });

  it('removes an aborted upload even when its filename is allocated after the abort', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'traceomics-upload-security-'));
    directories.push(directory);
    let allocationStarted;
    const started = new Promise(resolve => { allocationStarted = resolve; });
    let finishAllocation;
    let middlewareFinished;
    const finished = new Promise(resolve => { middlewareFinished = resolve; });
    const upload = multer({ storage: multer.diskStorage({
      destination: directory,
      filename(req, file, callback) {
        finishAllocation = () => callback(null, 'interrupted.csv');
        allocationStarted();
      },
    }) }).single('file');
    const url = await listen((req, res) => {
      upload(req, res, error => {
        middlewareFinished(error);
        if (!req.aborted) res.end('done');
      });
    });
    const request = http.request(url, { method: 'POST', headers: {
      'Content-Type': 'multipart/form-data; boundary=traceomics-security',
      'Content-Length': '1000000',
    } });
    request.on('error', () => {});
    request.write('--traceomics-security\r\nContent-Disposition: form-data; name="file"; filename="counts.csv"\r\nContent-Type: text/csv\r\n\r\ngene,cell\nGAPDH,1\n');
    await started;
    request.destroy();
    await new Promise(resolve => request.once('close', resolve));
    finishAllocation();
    expect(await finished).toBeTruthy();
    await expect.poll(async () => fs.readdir(directory), { timeout: 3000 }).toEqual([]);
  });
});
