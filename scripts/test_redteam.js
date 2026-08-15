#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const http = require('http');

const PORT = 3005;

let serverProcess;

// Helpers
let PASS = 0, FAIL = 0;
function pass(desc) { console.log(`  ✅ PASS: ${desc}`); PASS++; }
function fail(desc, detail = '') { console.log(`  ❌ FAIL: ${desc}${detail ? `\n     → ${detail}` : ''}`); FAIL++; }
function section(title) { console.log(`\n${title}\n${'─'.repeat(title.length)}`); }

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function req(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    let bodyStr = null;
    if (body) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        bodyStr = body;
      } else {
        bodyStr = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
      }
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: path,
      method: method,
      headers: headers
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, rawBody: data });
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn('node', ['server.js'], {
      env: { ...process.env, PORT: String(PORT), PLUMBER_PORT: '8005' }
    });

    serverProcess.stdout.on('data', data => {
      const msg = data.toString();
      // process.stdout.write(`[SERVER] ${msg}`);
      if (msg.includes('Starting local R Plumber backend')) {
        setTimeout(resolve, 5000); // give plumber a few seconds to start
      }
    });

    serverProcess.stderr.on('data', _data => {
      // process.stderr.write(`[SERVER ERR] ${_data.toString()}`);
    });

    serverProcess.on('error', err => {
      console.error('Failed to start server:', err);
      reject(err);
    });
  });
}

async function runTests() {
  console.log('Starting red-team tests...');
  section('1. Proxy Authentication Bypass');
  
  // Test 1: Hit plumber API without authentication
  // We expect this to fail (401/403) if the proxy is secure.
  const res1 = await req('GET', '/api/r/health');
  if (res1.status === 200 && res1.body && res1.body.status === 'ok') {
    fail('Proxy Authentication Bypass', 'Unauthenticated request to /api/r/health succeeded (200 OK). Plumber proxy blindly injects X-API-Token.');
  } else {
    pass('Proxy Authentication Bypass - Request blocked as expected.');
  }

  section('2. Unauthenticated Database Access');
  // Test 2: Modify the database anonymously
  const res2 = await req('POST', '/api/db/provenance', {
    provenance: {
      id: 'test-hacked-prov',
      operation: 'hack',
      script: 'rm -rf /',
    }
  });
  if (res2.status === 200) {
    fail('Unauthenticated Database Access', 'Successfully created a provenance record without authentication.');
  } else {
    pass('Unauthenticated Database Access - Modification blocked as expected.');
  }

  section('3. Unrestricted File Uploads');
  // Test 3: Upload a file without authentication or extension validation
  const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
  const fileContent = 'mock rds content';
  let postData = `--${boundary}\r\n`;
  postData += `Content-Disposition: form-data; name="file"; filename="hack.rds"\r\n`;
  postData += `Content-Type: application/octet-stream\r\n\r\n`;
  postData += `${fileContent}\r\n`;
  postData += `--${boundary}--\r\n`;

  const res3 = await req('POST', '/api/upload', postData, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`
  });

  let uploadedFilePath = null;
  if (res3.status === 200 && res3.body && res3.body.path) {
    fail('Unrestricted File Uploads', `Successfully uploaded a file anonymously. Path: ${res3.body.path}`);
    uploadedFilePath = res3.body.path;
  } else {
    pass('Unrestricted File Uploads - Upload blocked or required auth.');
  }

  section('4. Insecure Deserialization / Arbitrary Code Execution Risk');
  if (uploadedFilePath) {
    // Send the uploaded path to /api/r/load-rds
    const res4 = await req('POST', '/api/r/load-rds', { path: uploadedFilePath });
    // We expect a 500 error from R because it's a fake RDS, but if it's 500 instead of 401/403, 
    // it means it reached readRDS and tried to parse it!
    if (res4.status === 500 && res4.body && res4.body.error && res4.body.error.includes('unknown input format')) {
      fail('Insecure Deserialization / Arbitrary Code Execution Risk', 
        'Server accepted absolute path and called readRDS() on it! An attacker can upload a malicious RDS file to gain RCE.');
    } else if (res4.status === 200) {
      fail('Insecure Deserialization / Arbitrary Code Execution Risk', 'Server loaded the RDS file!');
    } else {
      pass('Insecure Deserialization - Request blocked.');
    }
  } else {
    console.log('  ℹ  Skipping deserialization test since file upload failed.');
  }

  section('5. Path Traversal via Absolute Paths');
  // Attempt to pass an arbitrary absolute path (like /etc/passwd or C:\Windows\System32\drivers\etc\hosts) to /api/r/load-rds
  const isWindows = process.platform === 'win32';
  const targetSysFile = isWindows ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
  const res5 = await req('POST', '/api/r/load-rds', { path: targetSysFile });
  
  if (res5.status === 500 && res5.body && res5.body.error && (res5.body.error.includes('unknown input format') || res5.body.error.includes('RDS'))) {
    fail('Path Traversal via Absolute Paths', 'Server bypassed vault restrictions and attempted to read ' + targetSysFile);
  } else {
    pass('Path Traversal - System file read blocked.');
  }

  console.log(`\nResults: ${PASS} passed, ${FAIL} failed.`);
  if (FAIL > 0) {
    console.log('\n❌ SECURITY REDTEAM FAILED. Vulnerabilities were successfully exploited. The application needs to be patched.');
  } else {
    console.log('\n✅ SECURITY REDTEAM PASSED. No vulnerabilities were exploitable.');
  }
}

async function main() {
  try {
    await startServer();
    await sleep(2000); // extra buffer
    await runTests();
  } catch (err) {
    console.error('Error during execution:', err);
  } finally {
    if (serverProcess) serverProcess.kill();
    process.exit(FAIL > 0 ? 1 : 0);
  }
}

main();
