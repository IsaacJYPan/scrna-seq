import { describe, expect, it, vi } from 'vitest';
const { DEMO_JOB_TYPES, demoAccountPolicy, demoCapabilityPolicy } = require('./demoExperiencePolicy');
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
describe('analysis demo capability policy', () => {
  it.each(['/api/auth/login', '/API/auth/LOGIN/', '/api/auth/signup', '/api/auth/change-password'])('blocks account route %s', path => {
    const next = vi.fn(); const res = response(); demoAccountPolicy(() => true)({ path }, res, next);
    expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
  });
  it('preserves account behavior outside this demo', () => {
    const next = vi.fn(); demoAccountPolicy(() => false)({ path: '/api/auth/login' }, {}, next); expect(next).toHaveBeenCalledOnce();
    expect(DEMO_JOB_TYPES).toEqual(['checkpoint.load.v1', 'checkpoint.save.v1']);
  });
  it.each([
    ['GET', '/api/r/cluster'], ['POST', '/api/r/normalize'], ['POST', '/api/projects/proj_1/members'],
    ['POST', '/api/projects/proj_1/datasets'], ['DELETE', '/api/projects/proj_1'], ['GET', '/api/r/load-data'],
  ])('blocks unsupported demo actions: %s %s', (method, path) => {
    const next = vi.fn(); const res = response(); demoCapabilityPolicy(() => true)({ method, path }, res, next);
    expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
  });
  it.each([
    ['GET', '/api/r/feature-values'], ['GET', '/api/r/object-info'], ['GET', '/api/r/qc-distributions'], ['POST', '/api/r/qc'],
    ['POST', '/api/projects/proj_1/jobs'], ['POST', '/api/auth/demo-guest'], ['GET', '/api/projects'],
    ['POST', '/api/runtime/activity'],
  ])('admits the analysis workflow: %s %s', (method, path) => {
    const next = vi.fn(); demoCapabilityPolicy(() => true)({ method, path }, {}, next); expect(next).toHaveBeenCalledOnce();
  });
  it.each(['PUT', 'DELETE'])('keeps unsupported activity methods blocked: %s', method => {
    const next = vi.fn(); const res = response();
    demoCapabilityPolicy(() => true)({ method, path: '/api/runtime/activity' }, res, next);
    expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
  });
  it.each([
    ['/api/r/normalize', { method: 'LogNormalize', scale_factor: '10000', nfeatures: '1500' }, 'nfeatures', '10000'],
    ['/api/r/pca', { npcs: '30', seed: '42' }, 'npcs', '100'],
    ['/api/r/cluster', { dims: '15', resolution: '0.8', algorithm: '1', seed: '42' }, 'resolution', '10'],
    ['/api/r/umap', { dims: '15', n_components: '2', n_neighbors: '20', min_dist: '0.5', seed: '42' }, 'n_neighbors', '200'],
  ])('admits bounded user parameters for %s and rejects excess or extra arguments', (path, query, key, excess) => {
    const next = vi.fn(); const res = response(); demoCapabilityPolicy(() => true)({ method: 'GET', path, query }, res, next);
    expect(next).toHaveBeenCalledOnce();
    for (const invalid of [{ ...query, [key]: excess }, { ...query, custom: 'code' }, { ...query, [key]: [query[key], query[key]] }]) {
      next.mockClear(); demoCapabilityPolicy(() => true)({ method: 'GET', path, query: invalid }, res, next); expect(next).not.toHaveBeenCalled();
    }
  });
});
