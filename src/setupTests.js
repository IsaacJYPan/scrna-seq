import '@testing-library/jest-dom';
import { beforeEach } from 'vitest';

// jsdom does not implement the browser's same-origin lock manager.
beforeEach(() => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  const queues = new Map();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      const waiting = queues.get(name) || Promise.resolve();
      const run = waiting.catch(() => {}).then(() => {
        if (options.signal?.aborted) throw new DOMException('Lock canceled.', 'AbortError');
        return callback({ name, mode: 'exclusive' });
      });
      queues.set(name, run.catch(() => {}));
      return run;
    },
  } });
});
