import { afterAll, beforeEach, describe, expect, it } from 'vitest';
const db = require('./pgDatabase');
const targets = require('./executionTargets');
const T0 = '2030-01-01 00:00:00';
const input = { operation:'r.object.inspect.v1', runtimeKind:'guided-r', runtimeGeneration:'a'.repeat(64), environment:{precision:'unavailable',reference:null} };
describe('execution target contracts', () => {
  it.each(['r.deg.find_markers.v1','r.condition.pseudobulk_de.v1'])('retains registered scientific operation %s', operation => {
    expect(targets.validateExecutionReceiptInput({...input,operation}).operation).toBe(operation);
  });
  it('rejects caller addresses, paths, invalid generations and unbounded labels', () => {
    const target = {kind:'service',id:'svc_'+'b'.repeat(32),label:'Lab server',generation:'c'.repeat(64),precision:'recorded-executor',runtimeKind:'guided-r',runtimeGeneration:null};
    expect(targets.validateExecutionTarget({...target,token:'secret'})).toEqual(target);
    for (const change of [{id:'https://other.example'}, {label:undefined}, {label:'C:/private'}, {label:'x'.repeat(81)}, {generation:'worker-host'}, {runtimeKind:'client'}]) {
      expect(() => targets.validateExecutionTarget({...target,...change})).toThrow();
    }
    expect(() => targets.validateExecutionReceiptInput({...input,environment:{precision:'pinned-request',reference:null}})).toThrow();
  });
  it('allows an omitted runtime generation on input but requires an explicit value in retained targets', () => {
    const withoutGeneration = { ...input };
    delete withoutGeneration.runtimeGeneration;
    expect(targets.validateExecutionReceiptInput(withoutGeneration).runtimeGeneration).toBe(null);
    const target = {
      kind: 'service', id: 'svc_' + 'b'.repeat(32), label: 'Lab server',
      generation: 'c'.repeat(64), precision: 'recorded-executor', runtimeKind: 'guided-r',
    };
    expect(() => targets.validateExecutionTarget(target)).toThrow();
    expect(targets.validateExecutionTarget({ ...target, runtimeGeneration: null }).runtimeGeneration).toBe(null);
    expect(() => targets.validateExecutionReceiptInput({ ...input, runtimeGeneration: '' })).toThrow();
  });
  it('converts a retained dispatch row and rejects invalid counters or timestamps', () => {
    const target = {
      kind: 'service', id: 'svc_' + 'b'.repeat(32), label: 'Lab server',
      generation: 'c'.repeat(64), precision: 'recorded-executor', runtimeKind: 'guided-r', runtimeGeneration: null,
    };
    const row = {
      dispatch_id: 'd'.repeat(64), attempt: '2', dispatch_at: '2030-01-01T00:00:00.000Z',
      operation: input.operation, target_json: target, environment_json: input.environment,
    };
    expect(targets.rowToExecutionReceipt(row)).toEqual({
      dispatchId: row.dispatch_id, attempt: 2, dispatchAt: row.dispatch_at,
      operation: input.operation, target, environment: input.environment,
    });
    for (const change of [
      { dispatch_id: 'worker-address' }, { attempt: 0 }, { attempt: 1.5 },
      { attempt: Number.MAX_SAFE_INTEGER + 1 }, { dispatch_at: null }, { dispatch_at: 'yesterday' },
      { environment_json: { precision: 'unavailable', reference: { path: '/private' } } },
    ]) {
      expect(() => targets.rowToExecutionReceipt({ ...row, ...change })).toThrow();
    }
  });
  it('requires complete installation metadata when a private kernel records its service identity', () => {
    const target = { kind: 'service', id: 'private-r', generation: 'a'.repeat(64) };
    expect(targets.validatePrivateKernelTarget({ ...target, token: 'private' })).toEqual(target);
    const recorded = { ...target, serviceId: 'svc_' + 'b'.repeat(32), serviceLabel: 'Lab server', runtimeKind: 'private-r' };
    expect(targets.validatePrivateKernelTarget(recorded)).toEqual(recorded);
    for (const change of [{ serviceId: 'https://lab.example' }, { serviceLabel: undefined }, { runtimeKind: 'guided-r' }]) {
      expect(() => targets.validatePrivateKernelTarget({ ...recorded, ...change })).toThrow();
    }
  });
});
describe.skipIf(!process.env.DATABASE_URL)('immutable dispatch receipts with real PostgreSQL claims', () => {
  let owner, job;
  beforeEach(async () => { await db.resetSchemaForTests(); owner=await db.createUser('target-owner@example.test','password123','Target owner'); job=await db.createJobForUser(owner.id,{jobType:'normalize'}); });
  afterAll(async () => { await db.close(); });
  it('retains installation identity through schema application, and first-dispatch evidence through completion', async () => {
    const firstIdentity=await db.getServiceExecutionIdentity(); await db.initSchema();
    expect(await db.getServiceExecutionIdentity()).toEqual(firstIdentity);
    const claim=await db.claimNextJob('worker-a',{now:T0,leaseSeconds:30});
    const first=await db.recordJobExecutionReceiptByWorker(job.id,'worker-a',claim.claimToken,input,{now:T0});
    const repeated=await db.recordJobExecutionReceiptByWorker(job.id,'worker-a',claim.claimToken,{...input,operation:'r.reduction.pca.v1'},{now:'2030-01-01 00:00:01'});
    expect(repeated).toEqual(first); expect(first.target.id).toBe(firstIdentity.id);
    expect(first.target.generation).toBe(targets.executorGeneration('worker-a'));
    expect(JSON.stringify(first)).not.toContain(claim.claimToken);
    await db.completeJobByWorker(job.id,'worker-a',claim.claimToken,{now:'2030-01-01 00:00:02'});
    expect(targets.rowToExecutionReceipt((await db.query('SELECT * FROM job_execution_receipts WHERE job_id=$1',[job.id])).rows[0])).toEqual(first);
    await expect(db.query("UPDATE job_execution_receipts SET operation='r.other.v1' WHERE job_id=$1",[job.id])).rejects.toMatchObject({code:'55000'});
    await expect(db.query("UPDATE service_execution_identity SET service_id=$1",['svc_'+'d'.repeat(32)])).rejects.toMatchObject({code:'55000'});
  });
  it('fences wrong and expired claims and separates claims even when release refunds the attempt counter', async () => {
    const claim=await db.claimNextJob('worker-a',{now:T0,leaseSeconds:30});
    await expect(db.recordJobExecutionReceiptByWorker(job.id,'worker-b',claim.claimToken,input,{now:T0})).rejects.toMatchObject({code:'CLAIM_LOST'});
    await expect(db.recordJobExecutionReceiptByWorker(job.id,'worker-a',claim.claimToken,input,{now:'2030-01-01 00:00:31'})).rejects.toMatchObject({code:'CLAIM_LOST'});
    expect((await db.query('SELECT * FROM job_execution_receipts')).rows).toHaveLength(0);
    const first=await db.recordJobExecutionReceiptByWorker(job.id,'worker-a',claim.claimToken,input,{now:T0});
    await db.releaseJob(job.id,'worker-a',claim.claimToken,{now:'2030-01-01 00:00:01'});
    const replacement=await db.claimNextJob('worker-b',{now:'2030-01-01 00:00:02',leaseSeconds:30});
    const second=await db.recordJobExecutionReceiptByWorker(job.id,'worker-b',replacement.claimToken,input,{now:T0});
    expect(second.attempt).toBe(first.attempt); expect(second.dispatchId).not.toBe(first.dispatchId);
    expect(second.target.generation).not.toBe(first.target.generation); expect(second.target.id).toBe(first.target.id);
    expect((await db.query('SELECT * FROM job_execution_receipts')).rows).toHaveLength(2);
    const latest=(await db.query('SELECT * FROM job_execution_receipts ORDER BY dispatch_order DESC LIMIT 1')).rows[0];
    expect(targets.rowToExecutionReceipt(latest)).toEqual(second);
  });
});
