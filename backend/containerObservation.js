'use strict';

const unavailable = () => ({ state: 'unavailable', scope: 'r-container', observedAt: null, memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, cpuLimit: null });
function quantity(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)$/.exec(value.trim());
  if (!match) return null;
  const factors = { B: 1, kB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4,
    KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  const bytes = Math.round(Number(match[1]) * factors[match[2]]);
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 64 * 1024 ** 3 ? bytes : null;
}
function validateObservation(value, now = Date.now()) {
  if (value?.state !== 'observed' || value.scope !== 'r-container') return unavailable();
  const timestamp = typeof value.observedAt === 'string' && value.observedAt.length <= 40 ? Date.parse(value.observedAt) : NaN;
  if (!Number.isFinite(timestamp) || timestamp > now + 1000 || now - timestamp > 15000
      || !Number.isSafeInteger(value.memoryBytes) || value.memoryBytes < 0
      || !Number.isSafeInteger(value.memoryLimitBytes) || value.memoryLimitBytes < 1 || value.memoryLimitBytes > 64 * 1024 ** 3
      || value.memoryBytes > value.memoryLimitBytes || !Number.isFinite(value.cpuPercent) || value.cpuPercent < 0 || value.cpuPercent > 6400
      || !Number.isFinite(value.cpuLimit) || value.cpuLimit < 0.25 || value.cpuLimit > 64) return unavailable();
  return { state: 'observed', scope: 'r-container', observedAt: new Date(timestamp).toISOString(),
    memoryBytes: value.memoryBytes, memoryLimitBytes: value.memoryLimitBytes, cpuPercent: value.cpuPercent, cpuLimit: value.cpuLimit };
}
// Each caller must verify the retained container identity and ownership before
// sampling. Names, paths, labels and daemon diagnostics never leave this helper.
function createContainerObserver({ runProcess, now = Date.now, cacheMs = 5000, maxConcurrent = 4 } = {}) {
  const cache = new Map(); let active = 0;
  return async function observe(containerId, limits) {
    if (!/^[a-f0-9]{64}$/.test(containerId || '') || !Number.isFinite(limits?.cpuLimit)) return unavailable();
    const current = now();
    for (const [key, entry] of cache) if (!entry.pending && current - entry.at > 15000) cache.delete(key);
    const prior = cache.get(containerId);
    if (prior?.pending) return prior.pending;
    if (prior && current - prior.at >= 0 && current - prior.at <= cacheMs) return validateObservation(prior.value, current);
    if (active >= maxConcurrent || cache.size >= 128 && !prior) return unavailable();
    const entry = { at: current, value: unavailable(), pending: null }; active++;
    entry.pending = (async () => {
      try {
        const result = await runProcess('docker', ['stats', '--no-stream', '--format', '{{json .}}', containerId], { timeoutMs: 2500 });
        if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 4096) return unavailable();
        const raw = JSON.parse(result.stdout.trim());
        const parts = typeof raw.MemUsage === 'string' ? raw.MemUsage.split('/') : [];
        const cpu = typeof raw.CPUPerc === 'string' && /^\d+(?:\.\d+)?%$/.test(raw.CPUPerc) ? Number(raw.CPUPerc.slice(0, -1)) : NaN;
        const value = validateObservation({ state: 'observed', scope: 'r-container', observedAt: new Date(now()).toISOString(),
          memoryBytes: quantity(parts[0]), memoryLimitBytes: quantity(parts[1]), cpuPercent: cpu, cpuLimit: limits.cpuLimit }, now());
        if (value.state === 'observed' && Number.isSafeInteger(limits.memoryBytes)
            && Math.abs(value.memoryLimitBytes - limits.memoryBytes) > Math.max(4096, limits.memoryBytes * 0.001)) return unavailable();
        return value;
      } catch { return unavailable(); }
    })().then(value => { entry.value = value; entry.at = now(); return value; }).finally(() => { entry.pending = null; active--; });
    cache.set(containerId, entry); return entry.pending;
  };
}

module.exports = { createContainerObserver, validateObservation, unavailable, quantity };
