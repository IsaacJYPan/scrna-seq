import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import journal from './liveExecutionJournal';

const { journalRecord, recordLiveRExecution, recordLiveRExecutionBounded } = journal;
function envelope() {
  return {
    provenance: { language: 'R', languageVersion: '4.5.1', script: 'print(ncol(object))', operation: 'pca',
      timestamp: '2026-10-08T10:30:00Z', parameters: { dims: 10 },
      execution: { generation: 'a'.repeat(64), order: 2, packages: [{ name: 'Seurat', version: '5.3.0' }] } },
    result: { points: [[1, 2]] }, live_state: { live_revision: 3 },
  };
}
function context() {
  return { method: 'POST', verifiedObjectId: 'ao_owned', user: { id: 1 } };
}

describe('server-owned live R execution journal', () => {
  it('records only actual declared source, resolved parameters and observed environment, excluding results and transport fields', () => {
    const response = envelope();
    response.token = 'private transport token';
    response.provenance.transport = '/work/private';
    const record = journalRecord(response);
    expect(record.sourceSha256).toBe(createHash('sha256').update(response.provenance.script).digest('hex'));
    expect(record.record).toEqual({ source: { language: 'R', code: response.provenance.script, sha256: record.sourceSha256 },
      parameters: { dims: 10 }, environment: { rVersion: '4.5.1', packages: [{ name: 'Seurat', version: '5.3.0' }] },
      target: { kind: 'service', id: 'interactive-r', precision: 'service-process' }, timestamp: response.provenance.timestamp, status: 'completed' });
    expect(JSON.stringify(record)).not.toContain('private transport');
    expect(JSON.stringify(record)).not.toContain('points');
  });

  it('leaves legacy responses explicitly unjournaled without inventing ordering', () => {
    const response = envelope(); delete response.provenance.execution;
    expect(journalRecord(response)).toBeNull();
  });

  it.each([
    response => { response.provenance.execution.order = 0; },
    response => { response.provenance.execution.generation = 'raw-session-id'; },
    response => { response.provenance.script = 'x'.repeat(32769); },
    response => { response.provenance.parameters = { value: 'x'.repeat(65536) }; },
    response => { response.provenance.timestamp = 'wrong'; },
    response => { response.live_state.live_revision = -1; },
    response => { response.provenance.parameters = JSON.parse('{"__proto__":{"injected":true}}'); },
  ])('rejects invalid or oversized trusted-service records', change => {
    const response = envelope(); change(response);
    expect(() => journalRecord(response)).toThrow(/could not be recorded/);
  });

  it('does not touch storage for unverified objects, unsupported requests, or legacy responses', async () => {
    const db = { query: vi.fn(), getAnalysisObjectForUser: vi.fn() };
    await expect(recordLiveRExecution({ db, req: { ...context(), verifiedObjectId: null }, envelope: envelope() })).resolves.toBeNull();
    await expect(recordLiveRExecution({ db, req: { ...context(), method: 'OPTIONS' }, envelope: envelope() })).resolves.toBeNull();
    expect(db.query).not.toHaveBeenCalled(); expect(db.getAnalysisObjectForUser).not.toHaveBeenCalled();
  });

  it('records legacy GET-based guided computations while inspection without provenance remains read-only', async () => {
    const db = { getAnalysisObjectForUser: vi.fn(async () => ({ projectId: 'proj_owned' })), query: vi.fn(async () => ({ rows: [{ id: 'lex_saved' }] })) };
    expect(await recordLiveRExecution({ db, req: { ...context(), method: 'GET' }, envelope: envelope() })).toEqual({ id: 'lex_saved', status: 'recorded' });
    db.query.mockClear(); db.getAnalysisObjectForUser.mockClear();
    expect(await recordLiveRExecution({ db, req: { ...context(), method: 'GET' }, envelope: { result: {}, live_state: { live_revision: 3 } } })).toBeNull();
    expect(db.query).not.toHaveBeenCalled(); expect(db.getAnalysisObjectForUser).not.toHaveBeenCalled();
  });

  it('derives the project from the current owned object and writes no client project identity', async () => {
    const db = { getAnalysisObjectForUser: vi.fn(async () => ({ projectId: 'proj_owned' })), query: vi.fn(async () => ({ rows: [{ id: 'lex_saved' }] })) };
    const req = { ...context(), body: { projectId: 'proj_foreign' } };
    expect(await recordLiveRExecution({ db, req, envelope: envelope() })).toEqual({ id: 'lex_saved', status: 'recorded' });
    expect(db.query.mock.calls[0][1].slice(1, 4)).toEqual(['proj_owned', 1, 'ao_owned']);
    expect(db.getAnalysisObjectForUser).toHaveBeenCalledWith('ao_owned', 1);
  });

  it('preserves idempotence when PostgreSQL reorders JSON object keys', async () => {
    const response = envelope(), stored = journalRecord(response);
    const record = stored.record;
    const db = { getAnalysisObjectForUser: async () => ({ projectId: 'proj_owned' }), query: vi.fn()
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'lex_old', source_sha256: stored.sourceSha256,
        analysis_object_id: 'ao_owned', operation: 'pca', live_revision: '3', record_json: {
          status: record.status, timestamp: record.timestamp, target: record.target, environment: record.environment,
          parameters: record.parameters, source: { sha256: record.source.sha256, code: record.source.code, language: 'R' },
        } }] }) };
    expect(await recordLiveRExecution({ db, req: context(), envelope: response })).toEqual({ id: 'lex_old', status: 'recorded' });
  });

  it('rejects conflicting replay of a recorded generation/order', async () => {
    const db = { getAnalysisObjectForUser: async () => ({ projectId: 'proj_owned' }), query: vi.fn()
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'lex_old', source_sha256: 'b'.repeat(64) }] }) };
    await expect(recordLiveRExecution({ db, req: context(), envelope: envelope() })).rejects.toThrow(/could not be recorded/);
  });

  it('bounds the history wait even if storage stalls, without retrying the completed analysis', async () => {
    const db = { getAnalysisObjectForUser: vi.fn(() => new Promise(() => {})), query: vi.fn() };
    await expect(recordLiveRExecutionBounded({ db, req: context(), envelope: envelope() }, 10)).rejects.toThrow(/could not be recorded/);
    expect(db.getAnalysisObjectForUser).toHaveBeenCalledOnce(); expect(db.query).not.toHaveBeenCalled();
  });
});
