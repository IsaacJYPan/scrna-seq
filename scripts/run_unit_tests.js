#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const RSCRIPT_CANDIDATES = [
  process.env.RSCRIPT_PATH,
  'C:\\Program Files\\R\\R-4.5.1\\bin\\Rscript.exe',
  'C:\\Program Files\\R\\R-4.4.3\\bin\\Rscript.exe',
  'C:\\Program Files\\R\\R-4.4.0\\bin\\Rscript.exe',
  '/usr/bin/Rscript',
  '/usr/local/bin/Rscript',
  'Rscript',
].filter(Boolean);

function findRscript() {
  const configPath = path.join(
    process.env.APPDATA || process.env.HOME || '',
    'scRNA-seq Workbench', 'config.json'
  );
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.rscriptPath && fs.existsSync(cfg.rscriptPath)) {
        return cfg.rscriptPath;
      }
    } catch (_) {}
  }

  for (const candidate of RSCRIPT_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return 'Rscript';
}

const rscript = findRscript();
const testScript = path.join(__dirname, '..', 'r-backend', 'tests', 'test_units.R');

console.log(`[R Unit Tests] Using Rscript at: ${rscript}`);

const rProc = spawn(rscript, [testScript], { stdio: 'inherit' });

rProc.on('close', (code) => {
  if (code !== 0) {
    console.error(`[R Unit Tests] Failed with exit code ${code}`);
    process.exit(code);
  } else {
    console.log(`[R Unit Tests] Passed!`);
    process.exit(0);
  }
});
rProc.on('error', (err) => {
  console.error(`[R Unit Tests] Error spawning Rscript: ${err.message}`);
  process.exit(1);
});
