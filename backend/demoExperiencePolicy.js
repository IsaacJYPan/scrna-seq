'use strict';

const DEMO_JOB_TYPES = Object.freeze(['checkpoint.load.v1', 'checkpoint.save.v1']);
const ACCOUNT_ROUTES = new Set(['/api/auth/login', '/api/auth/signup', '/api/auth/change-password']);
const READ_ROUTES = new Set(['/api/r/object-info', '/api/r/feature-values', '/api/r/pipeline-state', '/api/r/genes', '/api/r/qc-distributions']);
function numberBetween(value, min, max, integer = false) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n));
}
function allowedCompute(path, query = {}) {
  const keys = Object.keys(query);
  const only = names => keys.every(key => names.includes(key));
  const bound = (key, min, max, integer = false) => numberBetween(query[key], min, max, integer);
  if (path === '/api/r/normalize') return query.method === 'LogNormalize'
    && bound('scale_factor', 1000, 100000, true) && bound('nfeatures', 500, 3000, true)
    && only(['method', 'scale_factor', 'nfeatures']);
  if (path === '/api/r/pca') return bound('npcs', 10, 50, true) && query.seed === '42' && only(['npcs', 'seed']);
  if (path === '/api/r/cluster') return bound('dims', 2, 50, true) && bound('resolution', 0.1, 1.2)
    && query.algorithm === '1' && query.seed === '42' && only(['dims', 'resolution', 'algorithm', 'seed']);
  if (path === '/api/r/umap') return bound('dims', 2, 50, true) && query.n_components === '2'
    && bound('n_neighbors', 5, 50, true) && bound('min_dist', 0, 0.8) && query.seed === '42'
    && only(['dims', 'n_components', 'n_neighbors', 'min_dist', 'seed']);
  return false;
}
function demoAccountPolicy(isDemoMode) {
  return (req, res, next) => {
    const path = req.path.toLowerCase().replace(/\/+$/, '');
    if (isDemoMode() && ACCOUNT_ROUTES.has(path)) return res.status(403).json({ error: 'Accounts and login are disabled for this demo.' });
    return next();
  };
}
function demoCapabilityPolicy(isDemoMode) {
  return (req, res, next) => {
    const path = req.path.toLowerCase().replace(/\/+$/, '');
    if (!isDemoMode() || !path.startsWith('/api/')) return next();
    // QC's JSON body is validated by the existing bounded R proxy and Seurat API.
    const qc = path === '/api/r/qc' && req.method === 'POST';
    const allowedR = qc || (req.method === 'GET' && (READ_ROUTES.has(path) || allowedCompute(path, req.query)));
    const disabledR = path.startsWith('/api/r/') && !allowedR;
    const allowedWrite = qc || (req.method === 'POST' && (
      ['/api/auth/demo-guest', '/api/auth/logout', '/api/runtime/activity'].includes(path) || /^\/api\/projects\/[^/]+\/jobs$/.test(path)));
    const disabledWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !allowedWrite;
    if (disabledR || disabledWrite) return res.status(403).json({ error: 'This capability is disabled for the demo.' });
    return next();
  };
}
module.exports = { DEMO_JOB_TYPES, demoAccountPolicy, demoCapabilityPolicy };
