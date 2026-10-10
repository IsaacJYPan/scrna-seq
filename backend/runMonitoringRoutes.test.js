import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const express = require('express');
const { runMonitoringRoutes } = require('./runMonitoringRoutes');
let server, base;
const service = { list: vi.fn(), get: vi.fn() };
describe('monitoring GET route boundary', () => {
  beforeAll(async () => {
    const app = express();
    app.use('/api/run-monitoring', runMonitoringRoutes({ service, requireAuth: (req, res, next) => {
      if (req.headers.authorization !== 'Session approved') return res.status(401).json({ error: 'Authentication required.' });
      req.user = { id: 42 }; next();
    } }));
    server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
    base = 'http://127.0.0.1:' + server.address().port + '/api/run-monitoring';
  });
  beforeEach(() => { vi.clearAllMocks(); service.list.mockResolvedValue({ items: [] }); service.get.mockResolvedValue({ id: 'job_abc', status: 'running' }); });
  afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = (path = '/proj_monitor', options = {}) => fetch(base + path, { headers: { Authorization: 'Session approved' }, ...options });
  it('rejects unauthenticated access before reading any monitoring record', async () => {
    expect((await request('/proj_monitor', { headers: {} })).status).toBe(401);
    expect(service.list).not.toHaveBeenCalled(); expect(service.get).not.toHaveBeenCalled();
  });
  it('passes the authenticated owner and bounded page inputs into the read service', async () => {
    const response = await request('/proj_monitor?limit=2&before=cursor');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(service.list).toHaveBeenCalledWith(42, 'proj_monitor', { limit: '2', before: 'cursor' });
    expect(service.get).not.toHaveBeenCalled();
  });
  it('passes the exact selected durable run identity to a read-only detail call', async () => {
    expect((await request('/proj_monitor/job_abc')).status).toBe(200);
    expect(service.get).toHaveBeenCalledWith(42, 'proj_monitor', 'job_abc'); expect(service.list).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('does not implement %s or submit work from the monitoring endpoint', async method => {
    expect((await request('/proj_monitor/job_abc', { method })).status).toBe(404);
    expect(service.get).not.toHaveBeenCalled(); expect(service.list).not.toHaveBeenCalled();
  });
  it.each([['NOT_FOUND', 404], ['MONITORED_RUN_NOT_FOUND', 404], ['FORBIDDEN', 403], ['PROJECT_ROLE_REQUIRED', 403]])('projects the safe access failure %s', async (code, status) => {
    service.get.mockRejectedValueOnce(Object.assign(new Error('Run not found.'), { code }));
    const response = await request('/proj_monitor/job_abc');
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: 'Run not found.', code });
  });
  it('withholds unexpected database or broker messages and their credentials', async () => {
    service.get.mockRejectedValueOnce(Object.assign(new Error('postgres://owner:private-value@host/private-path'), { code: 'PRIVATE_INTERNAL_FAILURE' }));
    const response = await request('/proj_monitor/job_abc');
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'Run monitoring is temporarily unavailable. Refresh to inspect the retained state.' });
  });
  it('preserves a bounded unavailable response without leaking its internal cause', async () => {
    service.get.mockRejectedValueOnce(Object.assign(new Error('Bearer private-value'), { status: 503, code: 'MONITORING_RESPONSE_INVALID' }));
    const response = await request('/proj_monitor/job_abc');
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toMatch(/private-value|MONITORING_RESPONSE_INVALID/);
  });
});
