import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getExecutionEnvironment, getExecutionHistory, listExecutionHistory } from './executionHistoryApi';

vi.mock('../api', () => ({ apiUrl: value => value }));
beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

it('authenticates bounded category pages and encodes exact record references', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
  const controller = new AbortController();
  await listExecutionHistory('project 1', { kind: 'live-r', limit: 10, before: 'cursor=', signal: controller.signal });
  expect(fetch).toHaveBeenCalledWith('/api/execution-history/project%201?kind=live-r&limit=10&before=cursor%3D', expect.objectContaining({ credentials: 'include', signal: controller.signal }));
  await getExecutionHistory('project', 'job 1'); expect(fetch.mock.lastCall[0]).toBe('/api/execution-history/project/job%201');
  await getExecutionEnvironment('project', 'job 1'); expect(fetch.mock.lastCall[0]).toBe('/api/execution-history/project/job%201/environment');
});
it('hides network locations and invalid response bodies from errors', async () => {
  fetch.mockRejectedValueOnce(new Error('https://private-host/secret'));
  await expect(listExecutionHistory('project')).rejects.toThrow('Execution history could not be reached. Please try again.');
  fetch.mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError('<html>private'); } });
  await expect(listExecutionHistory('project')).rejects.toThrow('Execution history returned an invalid response. Please try again.');
});
it('retains bounded access/integrity failures and cancellation semantics', async () => {
  fetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Recorded bytes changed.', code: 'ENVIRONMENT_MANIFEST_INVALID' }) });
  await expect(getExecutionEnvironment('project', 'job')).rejects.toMatchObject({ message: 'Recorded bytes changed.', status: 409, code: 'ENVIRONMENT_MANIFEST_INVALID' });
  const aborted = new DOMException('Aborted', 'AbortError'); fetch.mockRejectedValueOnce(aborted);
  await expect(listExecutionHistory('project')).rejects.toBe(aborted);
});
