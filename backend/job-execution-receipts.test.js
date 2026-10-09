import { describe, expect, it, vi } from 'vitest';

const { createJobWorker } = require('./jobWorker');
const { environmentFixture } = require('./_executionHistoryFixtures');
const { summarizeEnvironmentManifest } = require('./rEnvironment');
const { observedRuntimeMetadata } = require('./executionHistoryProjection');
const NOW = '2030-01-01 00:00:00';
const logger = { info() {}, warn() {}, error() {} };
function fixture({ job = {}, db = {}, ...options } = {}) {
  const claimed = { id: 'job_owned', jobType: 'generic', ownerUserId: 1, projectId: 'proj_owned',
    attempts: 1, claimToken: 'private-claim', parameters: {}, ...job };
  const database = { reapExpiredJobs: vi.fn(async () => ({ requeued: [], failed: [] })),
    claimNextJob: vi.fn(async () => claimed), heartbeatJob: vi.fn(async () => claimed),
    appendJobLogByWorker: vi.fn(async () => {}), completeJobByWorker: vi.fn(async () => {}),
    failJobByWorker: vi.fn(async () => {}),
    recordJobExecutionReceiptByWorker: vi.fn(async () => ({ dispatchId: 'a'.repeat(64), attempt: 1 })),
    ...db };
  const callR = options.callR || vi.fn(async () => ({ status: 200, body: { status: 'ok' } }));
  const handler = options.handler || (async ctx => ({ result: await ctx.runRBridgeOperation({
    job: ctx.job, operation: 'r.runtime.check', actor: { userId: ctx.job.ownerUserId }, callR: ctx.callR,
  }) }));
  const worker = createJobWorker({ db: database, workerId: 'worker_first', now: () => NOW, logger,
    claimGate: async () => ({ ready: true, rRuntimeInstanceHash: 'b'.repeat(64) }),
    callR, handlers: { generic: handler }, ...options });
  return { worker, db: database, callR, claimed };
}

describe('worker execution target receipts at the actual dispatch boundary', () => {
  it('bounds returned package observations across several artifacts and drops private paths', () => {
    const values = Array.from({ length: 3 }, (_, index) => ({ environmentObserved: { rVersion: '4.5.1',
      packages: Array.from({ length: 100 }, (_, number) => ({ name: `package${index}n${number}`, version: '1.0.0' })) } }));
    values[0].environmentObserved.packages[0].version = 'C:/private/package';
    const observed = observedRuntimeMetadata(values);
    expect(observed.rVersion).toBe('4.5.1');
    expect(observed.packages).toHaveLength(100);
    expect(JSON.stringify(observed)).not.toContain('private/package');
  });

  it('persists claim-owned target evidence before calling the reviewed guided R operation', async () => {
    const events = [];
    const { worker, db, callR } = fixture({
      db: { recordJobExecutionReceiptByWorker: vi.fn(async () => { events.push('receipt'); return { attempt: 1 }; }) },
      callR: vi.fn(async () => { events.push('R'); return { status: 200, body: { status: 'ok' } }; }),
    });
    expect((await worker.runOnce()).status).toBe('completed');
    expect(events).toEqual(['receipt', 'R']);
    expect(db.recordJobExecutionReceiptByWorker).toHaveBeenCalledWith('job_owned', 'worker_first', 'private-claim',
      { operation: 'r.runtime.check', runtimeKind: 'guided-r', runtimeGeneration: 'b'.repeat(64),
        environment: { precision: 'unavailable', reference: null } }, { now: NOW });
    expect(callR.mock.calls[0][0]).toMatchObject({ method: 'GET', path: '/health' });
  });

  it.each([null, new Error('private database path failed')])('blocks R when target persistence cannot be confirmed (%s)', async failure => {
    const { worker, db, callR } = fixture({ db: { recordJobExecutionReceiptByWorker: vi.fn(async () => {
      if (failure) throw failure; return null;
    }) } });
    expect((await worker.runOnce()).status).toBe('failed');
    expect(callR).not.toHaveBeenCalled();
    expect(db.completeJobByWorker).not.toHaveBeenCalled();
    expect(JSON.stringify(db.failJobByWorker.mock.calls)).not.toContain('private database path');
  });

  it('does not fabricate dispatch evidence when bridge validation rejects an operation', async () => {
    const { worker, db, callR } = fixture({ handler: async ctx => ctx.runRBridgeOperation({
      job: ctx.job, operation: 'r.unreviewed', callR: ctx.callR,
    }) });
    expect((await worker.runOnce()).status).toBe('failed');
    expect(db.recordJobExecutionReceiptByWorker).not.toHaveBeenCalled();
    expect(callR).not.toHaveBeenCalled();
  });

  it('records the pinned sandbox request before dispatch without promoting it to a verified result', async () => {
    const reference = summarizeEnvironmentManifest(environmentFixture()); const events = [];
    const runExpertSandbox = vi.fn(async () => { events.push('sandbox'); return { ok: true }; });
    const { worker, db, callR } = fixture({ job: { parameters: { environment: reference } },
      db: { recordJobExecutionReceiptByWorker: vi.fn(async () => { events.push('receipt'); return { attempt: 1 }; }) },
      handler: async ctx => ({ result: await ctx.runExpertSandbox({ script: 'print(42)' }) }), runExpertSandbox });
    expect((await worker.runOnce()).status).toBe('completed');
    expect(events).toEqual(['receipt', 'sandbox']);
    expect(db.recordJobExecutionReceiptByWorker.mock.calls[0][3]).toMatchObject({
      operation: 'generic', runtimeKind: 'sandbox-r', runtimeGeneration: null,
      environment: { precision: 'pinned-request', reference },
    });
    expect(callR).not.toHaveBeenCalled();
  });

  it('does not create a replacement executor receipt while recovering committed output', async () => {
    const { worker, db, callR } = fixture({ db: { resumeCommittedJobByWorker: vi.fn(async () => ({ resumed: true })) } });
    expect((await worker.runOnce()).status).toBe('completed');
    expect(db.recordJobExecutionReceiptByWorker).not.toHaveBeenCalled();
    expect(callR).not.toHaveBeenCalled();
  });

  it('retains dispatch evidence on a failed R transport rather than substituting later connection state', async () => {
    const { worker, db } = fixture({ callR: vi.fn(async () => { throw Object.assign(new Error('private endpoint'), { code: 'R_UNREACHABLE' }); }),
      db: { deferIndeterminateRTimeoutByWorker: vi.fn(async () => {}) } });
    expect((await worker.runOnce()).status).toBe('indeterminate');
    expect(db.recordJobExecutionReceiptByWorker).toHaveBeenCalledTimes(1);
    expect(db.completeJobByWorker).not.toHaveBeenCalled();
  });

  it('retains bounded runtime versions returned during hydration for a subsequent aggregate output', async () => {
    const { worker } = fixture({
      rBridge: { runRBridgeOperation: async ({ operation, callR }) => {
        await callR({ method: 'POST', path: '/reviewed-test' });
        return operation === 'r.checkpoint.hydrate.v1'
          ? { loaded: { rVersion: '4.5.1', seuratVersion: '5.3.0', internalStorageKey: 'C:/private/input.rds' } }
          : { metadata: { operation, summary: { nCells: 2 } } };
      } },
      handler: async ctx => {
        await ctx.runRBridgeOperation({ operation: 'r.checkpoint.hydrate.v1' });
        return { result: await ctx.runRBridgeOperation({ operation: 'r.explore.summarize.v1' }) };
      },
    });
    const outcome = await worker.runOnce();
    expect(outcome.result.metadata.environmentObserved).toEqual({ rVersion: '4.5.1', packages: [{ name: 'Seurat', version: '5.3.0' }] });
    expect(JSON.stringify(outcome.result)).not.toContain('private/input');
  });
});
