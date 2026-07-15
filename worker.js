#!/usr/bin/env node
'use strict';

const { createStandaloneWorkerRuntime } = require('./backend/workerRuntime');

async function main(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const logger = options.logger || console;
  const exit = options.exit || ((code) => process.exit(code));
  let fatalExitIssued = false;
  const runtimeOptions = { ...(options.runtimeOptions || {}) };
  if (typeof runtimeOptions.onFatal !== 'function') {
    runtimeOptions.onFatal = (code) => {
      if (fatalExitIssued) return;
      fatalExitIssued = true;
      exit(code);
    };
  }
  const runtime = (options.createRuntime || createStandaloneWorkerRuntime)(runtimeOptions);
  const once = argv.includes('--once');
  if (argv.some((arg) => arg !== '--once')) {
    throw Object.assign(new Error('Unknown worker argument.'), { code: 'INVALID_WORKER_ARGUMENT' });
  }

  await runtime.start({ autoStart: !once });
  if (once) {
    const result = await runtime.worker.runOnce();
    if (typeof logger.info === 'function') logger.info(`[worker] one-shot result: ${result.status}.`);
    const code = await runtime.shutdown();
    exit(code);
    return { runtime, result, exitCode: code };
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const code = await runtime.shutdown();
    exit(code);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  process.on('message', (message) => {
    if (message && message.type === 'benchone:shutdown') void stop();
  });
  return { runtime, stop };
}

if (require.main === module) {
  main().catch((error) => {
    const code = error && error.code ? String(error.code).replace(/[^A-Z0-9_]/gi, '').slice(0, 64) : 'STARTUP_FAILED';
    console.error(`[worker] refusing to start (${code || 'STARTUP_FAILED'}).`);
    process.exit(1);
  });
}

module.exports = { main };
