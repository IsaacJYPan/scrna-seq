import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';

const {
  DEFAULT_DEV_WORKER_MIN_FREE_MEMORY_MB,
  createDevRuntime,
} = require('./dev-runtime');
const { parseStandaloneWorkerConfig } = require('../backend/workerRuntime');

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.connected = true;
  child.send = (_message, callback) => {
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      if (typeof callback === 'function') callback();
    });
    return true;
  };
  child.kill = (signal) => {
    queueMicrotask(() => {
      child.signalCode = signal;
      child.emit('exit', null, signal);
    });
    return true;
  };
  return child;
}

function startRuntime(env = {}) {
  const launches = [];
  const runtime = createDevRuntime({
    env: {
      R_RUNTIME_MODE: 'external',
      R_BACKEND_URL: 'http://127.0.0.1:8000',
      R_API_TOKEN: 'x'.repeat(32),
      ...env,
    },
    spawn: (command, args, options) => {
      launches.push({ command, args, options });
      return fakeChild();
    },
    exit: () => {},
  });
  runtime.start();
  return { runtime, launches };
}

describe('local development runtime memory admission', () => {
  it('does not change the standalone worker production default', () => {
    const config = parseStandaloneWorkerConfig({ ENABLE_JOB_WORKER: 'true' }, {
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(config.minFreeMemoryMb).toBe(1024);
  });

  it('uses a constrained-workstation fallback only for its spawned worker', async () => {
    const { runtime, launches } = startRuntime();
    const worker = launches.find(({ args }) => args[0].endsWith('worker.js'));
    const web = launches.find(({ args }) => args[0].endsWith('server.js'));

    expect(DEFAULT_DEV_WORKER_MIN_FREE_MEMORY_MB).toBe(256);
    expect(worker.options.env.JOB_WORKER_MIN_FREE_MEMORY_MB).toBe('256');
    expect(web.options.env.JOB_WORKER_MIN_FREE_MEMORY_MB).toBeUndefined();

    await runtime.stop();
  });

  it('preserves an explicit worker admission threshold', async () => {
    const { runtime, launches } = startRuntime({ JOB_WORKER_MIN_FREE_MEMORY_MB: '768' });
    const worker = launches.find(({ args }) => args[0].endsWith('worker.js'));

    expect(worker.options.env.JOB_WORKER_MIN_FREE_MEMORY_MB).toBe('768');

    await runtime.stop();
  });

  it('does not replace an explicit invalid setting with the development fallback', async () => {
    const { runtime, launches } = startRuntime({ JOB_WORKER_MIN_FREE_MEMORY_MB: 0 });
    const worker = launches.find(({ args }) => args[0].endsWith('worker.js'));

    expect(worker.options.env.JOB_WORKER_MIN_FREE_MEMORY_MB).toBe('0');

    await runtime.stop();
  });
});
