'use strict';

// Test-only: a pipeline reply as the real R runtime gives it, reporting the
// parameters it ran with. The bridge refuses pipeline results that do not
// (rWorkerBridge.js verifiedEffectiveParameters).
function withEffectiveParameters(request, body) {
  if (!body || typeof body !== 'object' || Object.prototype.hasOwnProperty.call(body, 'effective_parameters')) return body;
  const params = request && request.body && request.body.params;
  return params && typeof params === 'object' ? { ...body, effective_parameters: params } : body;
}

module.exports = { withEffectiveParameters };
