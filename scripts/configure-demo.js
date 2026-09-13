#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

function generateDemoConfig(hostname) {
  if (
    typeof hostname !== 'string' ||
    hostname.length > 253 ||
    !hostname.includes('.') ||
    /^\d+(\.\d+){3}$/.test(hostname) ||
    hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  ) {
    throw new Error(
      'Use a public DNS hostname, such as demo.example.org, without a scheme, port, or path.'
    );
  }
  const values = {
    PUBLIC_HOST: hostname.toLowerCase(),
    FRONTEND_ORIGIN: `https://${hostname.toLowerCase()}`,
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    SESSION_EPOCH: crypto.randomBytes(16).toString('hex'),
    R_API_TOKEN: crypto.randomBytes(32).toString('hex'),
    POSTGRES_PASSWORD: crypto.randomBytes(24).toString('hex'),
    APP_DATABASE_PASSWORD: crypto.randomBytes(24).toString('hex'),
  };
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'demo-free-tier.env.example'),
    'utf8'
  );
  return template.replace(/^([A-Z_]+)=.*$/gm, (line, name) =>
    Object.hasOwn(values, name) ? `${name}=${values[name]}` : line
  );
}

function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: 'string' },
      output: { type: 'string', default: 'deploy/demo.env' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: npm run demo:configure -- --host demo.example.org [--output deploy/demo.env]'
    );
    return;
  }
  const config = generateDemoConfig(values.host);
  fs.writeFileSync(values.output, config, { flag: 'wx', mode: 0o600 });
  console.log(
    `Created ${values.output}. Keep this file private; it contains deployment credentials.`
  );
  console.log('Next: build the images and bootstrap the tutorial using docs/demo.md.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      error.code === 'EEXIST'
        ? 'Configuration already exists. Choose a new output file to avoid replacing deployment secrets.'
        : error.message
    );
    process.exitCode = 1;
  }
}

module.exports = { generateDemoConfig, main };
