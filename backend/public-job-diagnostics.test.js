import { describe, expect, it } from 'vitest';
const { toPublicJob } = require('./pgDatabase');

describe('public job diagnostic projection', () => {
  it('bounds retained logs and scrubs credentials and paths across all job read routes', () => {
    const logs = Array.from({ length: 70 }, (_, index) => ({ ts: '2030-01-01T00:00:00Z', level: 'info', message: `Event ${index}` }));
    logs.push({ ts: null, message: 'Authorization: Bearer private-token', privatePath: '/private/data' });
    logs.push({ message: 'Failure at C:\\private\\analysis.rds' });
    const original = { id: 'job_owned', status: 'failed', logs, claimToken: 'private-claim', workerId: 'worker-private',
      error: { code: 'R_ERROR', message: 'password=private-password', privateNested: 'private-path' } };
    const projected = toPublicJob(original);
    expect(projected.logs).toHaveLength(50);
    expect(projected.logs[0].message).toBe('Event 22');
    expect(projected.error.code).toBe('R_ERROR');
    expect(JSON.stringify(projected)).not.toMatch(/private-token|private-password|private-path|private-claim|worker-private|privateNested|privatePath|private\\\\/);
    expect(original.logs).toHaveLength(72);expect(original.error.message).toBe('password=private-password');
  });
});
