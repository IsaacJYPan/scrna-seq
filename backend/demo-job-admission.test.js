import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const db = require('./pgDatabase');
const config = require('./config');
const savedMode = process.env.APP_DEPLOYMENT_MODE;
const savedLimit = process.env.DEMO_MAX_GLOBAL_HEAVY_JOBS;

describe.skipIf(!config.hasPostgresConnection())('transactional public demo heavy admission', () => {
  beforeEach(async () => {
    await db.resetSchemaForTests();
    process.env.APP_DEPLOYMENT_MODE = 'demo';
    process.env.DEMO_MAX_GLOBAL_HEAVY_JOBS = '1';
  });
  afterAll(async () => {
    if (savedMode === undefined) delete process.env.APP_DEPLOYMENT_MODE;
    else process.env.APP_DEPLOYMENT_MODE = savedMode;
    if (savedLimit === undefined) delete process.env.DEMO_MAX_GLOBAL_HEAVY_JOBS;
    else process.env.DEMO_MAX_GLOBAL_HEAVY_JOBS = savedLimit;
    await db.close();
  });
  async function guests() {
    return Promise.all([1,2,3].map(n => db.createDemoGuest(
      `admission-${n}@example.test`, 'test-password-123', new Date(Date.now()+7200000).toISOString())));
  }
  const launch = (guest) => db.createProjectJob(guest.user.id, guest.project.id,
    { jobType:'explore.summarize.v1', parameters:{ recipe:'overview' } });

  it('admits exactly one of concurrent different-guest heavy submissions', async () => {
    const input=await guests();
    const results=await Promise.allSettled(input.map(launch));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='DEMO_COMPUTE_LIMIT')).toBe(true);
    const rows=await db.query("SELECT COUNT(*)::int AS count FROM jobs WHERE status='queued'");
    expect(rows.rows[0].count).toBe(1);
  });
  it('keeps two global admissions when the override is absent', async () => {
    delete process.env.DEMO_MAX_GLOBAL_HEAVY_JOBS;
    const results=await Promise.allSettled((await guests()).map(launch));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
  });
  it('does not consume the heavy limit for checkpoint work', async () => {
    const [guest]=await guests(); await launch(guest);
    const job=await db.createProjectJob(guest.user.id,guest.project.id,{jobType:'checkpoint.noop'});
    expect(job.status).toBe('queued');
  });
});
