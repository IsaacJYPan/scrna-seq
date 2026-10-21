// Public error messages and dispatch ambiguity for worker-to-R calls.

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// A failed response may follow committed R work. Keep this recovery signal off public errors.
function markRSideEffectsPossible(error) {
  const err =
    error instanceof Error ? error : codedError('R_BRIDGE_ERROR', 'R bridge operation failed.');
  Object.defineProperty(err, 'rSideEffectsPossible', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return err;
}

function sanitizeRDiagnosticCode(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^a-z0-9_.:-]/gi, '').slice(0, 80);
  return cleaned || null;
}

function sanitizeRBridgeError(err) {
  const code = err && typeof err.code === 'string' ? err.code : 'R_BRIDGE_ERROR';
  const SAFE_MESSAGES = {
    UNSUPPORTED_R_OPERATION: 'Requested R bridge operation is not allowlisted.',
    R_BRIDGE_TARGET_REJECTED: 'Requested R bridge target is not allowlisted.',
    R_BRIDGE_MISCONFIGURED: 'R bridge is not configured.',
    R_OBJECT_CONTEXT_REQUIRED: 'Server-derived object context is required for object inspection.',
    R_PIPELINE_PARAMS_REQUIRED: 'Server-validated pipeline parameters are required.',
    R_DEG_PARAMS_REQUIRED: 'Server-validated DEG parameters and result key are required.',
    R_ENRICHMENT_PARAMS_REQUIRED:
      'Server-validated pathway-enrichment parameters and result key are required.',
    R_CELLCHAT_PARAMS_REQUIRED:
      'Server-validated cell-communication parameters and result key are required.',
    R_CHECKPOINT_REQUIRED: 'A server-selected checkpoint is required for a checkpoint load.',
    R_TIMEOUT: 'R runtime did not respond before the timeout.',
    R_RESPONSE_TOO_LARGE: 'R runtime response exceeded its safe limit.',
    R_RESPONSE_INVALID: 'R runtime returned an invalid response.',
    R_UNREACHABLE: 'R runtime is unreachable.',
    R_RUNTIME_CHECK_FAILED: 'R runtime check failed.',
    R_OBJECT_INSPECT_FAILED: 'R object inspection failed.',
    R_PBMC_PIPELINE_FAILED: 'R PBMC pipeline run failed.',
    R_CHECKPOINT_LOAD_FAILED: 'R checkpoint load failed.',
    R_DEG_FIND_MARKERS_FAILED: 'R DEG / marker finding run failed.',
    R_ENRICHMENT_GSEA_FAILED: 'R ranked pathway-enrichment run failed.',
    R_CELLCHAT_INFERENCE_FAILED: 'R cell-communication inference run failed.',
    R_SEURAT_PIPELINE_FAILED: 'R Seurat pipeline run failed.',
    R_BRIDGE_ERROR: 'R bridge operation failed.',
  };
  return { code, message: SAFE_MESSAGES[code] || SAFE_MESSAGES.R_BRIDGE_ERROR };
}

module.exports = {
  codedError,
  markRSideEffectsPossible,
  sanitizeRDiagnosticCode,
  sanitizeRBridgeError,
};
