// Worker-to-R requests use fixed operations and server-derived object context.
// Handlers authorize object access; the bridge rebuilds payloads and sanitizes responses.
// Request policy and completion recovery live in rBridge/operations and rBridge/completionReceipts.

const http = require('http');
const https = require('https');
const { PBMC_PIPELINE_PARAM_NAMES } = require('./pbmcPipeline');
const { DEG_FIND_MARKERS_PARAM_NAMES } = require('./degFindMarkers');
const { ENRICHMENT_GSEA_PARAM_NAMES } = require('./enrichmentGsea');
const { CELLCHAT_INFERENCE_PARAM_NAMES, MAX_CELLCHAT_RESULT_ROWS } = require('./cellChatInference');
const { SEURAT_PIPELINE_PARAM_NAMES } = require('./seuratPipeline');
const { EXPLORATORY_ANALYSIS_PARAM_NAMES } = require('./exploratoryAnalysis');
const {
  codedError,
  sanitizeRBridgeError,
  markRSideEffectsPossible,
  sanitizeRDiagnosticCode,
} = require('./rBridge/errors');
const {
  isAllowedRBridgeTarget,
  isAllowedRBridgeOperation,
  R_BRIDGE_OPERATIONS,
  R_BRIDGE_ALLOWED_TARGETS,
} = require('./rBridge/operations');
const {
  verifyCompletionReceiptEnvelope,
  buildCompletionReceiptBinding,
  isPlainObject,
  createCompletionReceiptEnvelope,
  descriptorFromCompletionReceipt,
} = require('./rBridge/completionReceipts');
const {
  sanitizePipelineSummary,
  sanitizeCheckpointInfo,
  sanitizeLoadSummary,
  sanitizeDegSummary,
  sanitizeDegResultInfo,
  sanitizeExplorationSummary,
  sanitizeEnrichmentSummary,
  sanitizeEnrichmentResultInfo,
  sanitizeConditionComparisonSummary,
  sanitizeCellChatSummary,
  sanitizeCellChatResultInfo,
  isCompleteCellChatSummary,
  sanitizeNameList,
  sanitizeInspectionSummary,
  sanitizeRuntimeField,
  sanitizeCount,
  sanitizeChecksum,
  sanitizeStatNumber,
  sanitizeCellChatGroup,
} = require('./rBridge/summaries');

const DEFAULT_R_BRIDGE_TIMEOUT_MS = 10000;

const MAX_R_BRIDGE_TIMEOUT_MS = 600000;

function createDefaultRCaller(config = {}) {
  let endpoint = null;
  try {
    endpoint = new URL(
      config.baseUrl ||
        process.env.R_BACKEND_URL ||
        `http://127.0.0.1:${Number(config.port) || Number(process.env.PLUMBER_PORT) || 8000}`
    );
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.pathname && endpoint.pathname !== '/')
    ) {
      endpoint = null;
    }
  } catch {
    endpoint = null;
  }
  const token = config.token || process.env.API_TOKEN || '';
  const maxResponseBytes =
    Number.isInteger(Number(config.maxResponseBytes)) && Number(config.maxResponseBytes) > 0
      ? Math.min(Number(config.maxResponseBytes), 4 * 1024 * 1024)
      : 1024 * 1024;

  const callR = function callR({ method, path, timeoutMs, objectStateKey, body }) {
    return new Promise((resolve, reject) => {
      if (!token || !endpoint) {
        reject(codedError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.'));
        return;
      }
      // Defense-in-depth: only the known bridge targets may ever be issued.
      if (!isAllowedRBridgeTarget(method, path)) {
        reject(
          codedError('R_BRIDGE_TARGET_REJECTED', 'Requested R bridge target is not allowlisted.')
        );
        return;
      }
      let settled = false;
      let deadline = null;
      const finishOk = (v) => {
        if (!settled) {
          settled = true;
          if (deadline) clearTimeout(deadline);
          resolve(v);
        }
      };
      const finishErr = (e) => {
        if (!settled) {
          settled = true;
          if (deadline) clearTimeout(deadline);
          reject(e);
        }
      };

      const headers = { 'X-API-Token': token, Accept: 'application/json' };
      // Server-derived object state key only (never client-controlled). Absent for
      // r.runtime.check, so that operation cannot reach per-object live R state.
      if (typeof objectStateKey === 'string' && objectStateKey !== '') {
        headers['X-Object-ID'] = objectStateKey;
      }

      // A request body is only ever sent for a POST target (the pipeline op). It is a
      // SERVER-built, JSON-serializable object (the bridge reconstructs it from the
      // allowlisted params + checkpoint key); raw client input never reaches here.
      let payload = null;
      if (method === 'POST' && body !== undefined && body !== null) {
        payload = Buffer.from(JSON.stringify(body), 'utf8');
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }

      let req;
      try {
        const transport = endpoint.protocol === 'https:' ? https : http;
        req = transport.request(
          {
            protocol: endpoint.protocol,
            hostname: endpoint.hostname,
            port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
            method,
            path,
            headers,
          },
          (res) => {
            const chunks = [];
            let responseBytes = 0;
            res.on('data', (c) => {
              responseBytes += c.length;
              if (responseBytes > maxResponseBytes) {
                req.destroy();
                finishErr(
                  codedError('R_RESPONSE_TOO_LARGE', 'R runtime response exceeded its safe limit.')
                );
                return;
              }
              chunks.push(c);
            });
            res.on('end', () => {
              if (settled) return;
              const raw = Buffer.concat(chunks).toString('utf8');
              let resBody = null;
              try {
                resBody = raw ? JSON.parse(raw) : null;
              } catch {
                resBody = null;
              }
              finishOk({ status: res.statusCode, body: resBody });
            });
          }
        );
      } catch {
        // Never surface the raw construction error (could include host/port).
        finishErr(codedError('R_UNREACHABLE', 'R runtime is unreachable.'));
        return;
      }

      // Total wall-clock deadline, not merely an idle-socket timeout. A peer that
      // slowly streams bytes therefore cannot keep a heavy-job claim alive forever.
      deadline = setTimeout(
        () => {
          req.destroy();
          finishErr(codedError('R_TIMEOUT', 'R runtime did not respond before the timeout.'));
        },
        Number(timeoutMs) || DEFAULT_R_BRIDGE_TIMEOUT_MS
      );
      if (typeof deadline.unref === 'function') deadline.unref();
      // Collapse every transport-level error to a generic, host/URL-free code.
      req.on('error', () => finishErr(codedError('R_UNREACHABLE', 'R runtime is unreachable.')));
      if (payload) req.write(payload);
      req.end();
    });
  };
  // Keep the shared secret closed over by the caller. Recovery receives only a
  // verifier capability; the API token is never copied into worker state or logs.
  Object.defineProperty(callR, 'verifyCompletionReceipt', {
    value: (envelope) => verifyCompletionReceiptEnvelope(envelope, token),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return callR;
}

async function runRBridgeOperation(args = {}) {
  const { job, operation, callR } = args;
  const logger = args.logger || console;

  // 1. Operation must be explicitly allowlisted. Arbitrary names are refused here,
  //    before any R contact.
  if (!isAllowedRBridgeOperation(operation)) {
    throw codedError('UNSUPPORTED_R_OPERATION', 'Requested R bridge operation is not allowlisted.');
  }
  if (!job || typeof job !== 'object') {
    throw codedError('R_BRIDGE_ERROR', 'A trusted job context is required.');
  }
  if (typeof callR !== 'function') {
    throw codedError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  // 2. The request method/path are built ENTIRELY from the server-defined spec.
  //    `args.input` is deliberately never read: the caller cannot choose method/path/
  //    code/endpoint/state key.
  const spec = R_BRIDGE_OPERATIONS[operation];
  // Timeout: an explicit caller value wins, else the op's own default (the pipeline op
  // is longer), else the global default — always clamped to a hard ceiling so no call
  // can run unbounded.
  const requestedTimeout =
    Number.isInteger(args.timeoutMs) && args.timeoutMs > 0
      ? args.timeoutMs
      : Number.isInteger(spec.defaultTimeoutMs) && spec.defaultTimeoutMs > 0
        ? spec.defaultTimeoutMs
        : DEFAULT_R_BRIDGE_TIMEOUT_MS;
  const timeoutMs = Math.min(requestedTimeout, MAX_R_BRIDGE_TIMEOUT_MS);
  const request = { method: spec.method, path: spec.path, timeoutMs };

  // 2a. Object operations need SERVER-DERIVED object context (never from input). The
  //     state key is the X-Object-ID the bridge sends; it is derived by the worker
  //     handler from the trusted job + owner-verified deriver, never client-provided.
  let objectContext = null;
  if (spec.requiresObjectContext) {
    objectContext = args.objectContext;
    if (
      !objectContext ||
      typeof objectContext !== 'object' ||
      typeof objectContext.stateKey !== 'string' ||
      objectContext.stateKey === '' ||
      typeof objectContext.objectId !== 'string' ||
      objectContext.objectId === ''
    ) {
      throw codedError(
        'R_OBJECT_CONTEXT_REQUIRED',
        'Server-derived object context is required for object inspection.'
      );
    }
    request.objectStateKey = objectContext.stateKey;
  }

  // 2b. Operations that carry parameters (the pipeline op) get a SERVER-BUILT JSON body
  //     reconstructed from ONLY the allowlisted param names + the server-allocated
  //     checkpoint key. `args.pipeline` is supplied by the worker handler AFTER it has
  //     validated the params (backend/pbmcPipeline.js) and allocated the key; raw
  //     client input is never forwarded. Re-whitelisting here is defense-in-depth: a
  //     stray/hostile field on the params object can never reach R.
  if (spec.carriesParams) {
    const pipeline = args.pipeline;
    const params = pipeline && typeof pipeline === 'object' ? pipeline.params : null;
    const checkpointStorageKey =
      pipeline && typeof pipeline === 'object' ? pipeline.checkpointStorageKey : null;
    if (
      !params ||
      typeof params !== 'object' ||
      typeof checkpointStorageKey !== 'string' ||
      checkpointStorageKey === ''
    ) {
      throw codedError(
        'R_PIPELINE_PARAMS_REQUIRED',
        'Server-validated pipeline parameters are required.'
      );
    }
    const safeParams = {};
    for (const name of PBMC_PIPELINE_PARAM_NAMES) {
      if (Object.prototype.hasOwnProperty.call(params, name)) safeParams[name] = params[name];
    }
    // `storage_key` is a TOP-LEVEL body field (matches R's validate_path arg + the
    // Node proxy's R_PROXY_VALIDATED_PATH_FIELDS allowlist).
    request.body = { operation, params: safeParams, storage_key: checkpointStorageKey };
  }

  // Explicit live-state save: the body contains only the fixed operation name
  // and a server-allocated project checkpoint key. No client parameter or path
  // is forwarded to R.
  if (spec.carriesCheckpointSave) {
    const checkpointStorageKey = args.checkpointSave && args.checkpointSave.checkpointStorageKey;
    if (typeof checkpointStorageKey !== 'string' || checkpointStorageKey === '') {
      throw codedError(
        'R_CHECKPOINT_SAVE_REQUIRED',
        'A server-allocated checkpoint destination is required.'
      );
    }
    request.body = { operation, storage_key: checkpointStorageKey };
  }

  // 2c. Checkpoint-load op: a SERVER-BUILT body reconstructed from ONLY the server-
  //     SELECTED checkpoint coordinates (the internal storage key + expected integrity).
  //     `args.checkpoint` is supplied by the worker handler AFTER it has verified
  //     ownership and resolved the loadable checkpoint (database.js
  //     getLoadableCheckpointForAnalysisObject); raw client input is never forwarded and
  //     there is NO client-controlled storage key/path. The expected checksum/size let R
  //     re-verify file integrity before deserializing.
  if (spec.carriesCheckpoint) {
    const cp = args.checkpoint;
    const storageKey = cp && typeof cp === 'object' ? cp.internalStorageKey : null;
    if (!cp || typeof cp !== 'object' || typeof storageKey !== 'string' || storageKey === '') {
      throw codedError(
        'R_CHECKPOINT_REQUIRED',
        'A server-selected checkpoint is required for a checkpoint load.'
      );
    }
    // `storage_key` is the TOP-LEVEL body field R confines via validate_path() and the
    // Node proxy's R_PROXY_VALIDATED_PATH_FIELDS allowlist already covers.
    const loadBody = { operation, storage_key: storageKey };
    if (typeof cp.checksumSha256 === 'string' && cp.checksumSha256 !== '') {
      loadBody.expected_checksum_sha256 = cp.checksumSha256;
    }
    if (Number.isFinite(cp.sizeBytes) && cp.sizeBytes >= 0) {
      loadBody.expected_size_bytes = cp.sizeBytes;
    }
    request.body = loadBody;
  }

  // 2d. DEG op: a SERVER-BUILT body reconstructed from ONLY the allowlisted, server-
  //     validated DEG params + the SERVER-allocated result storage key. `args.deg` is
  //     supplied by the worker handler AFTER it has validated the params
  //     (backend/degFindMarkers.js) and allocated the key; raw client input is never
  //     forwarded and there is NO client-controlled storage key/path. Re-whitelisting the
  //     param names here is defense-in-depth: a stray/hostile field can never reach R.
  if (spec.carriesDegParams) {
    const deg = args.deg;
    const params = deg && typeof deg === 'object' ? deg.params : null;
    const resultStorageKey = deg && typeof deg === 'object' ? deg.resultStorageKey : null;
    if (
      !params ||
      typeof params !== 'object' ||
      typeof resultStorageKey !== 'string' ||
      resultStorageKey === ''
    ) {
      throw codedError(
        'R_DEG_PARAMS_REQUIRED',
        'Server-validated DEG parameters and result key are required.'
      );
    }
    const safeParams = {};
    for (const name of DEG_FIND_MARKERS_PARAM_NAMES) {
      if (Object.prototype.hasOwnProperty.call(params, name)) safeParams[name] = params[name];
    }
    // `storage_key` is a TOP-LEVEL body field (matches R's validate_path arg + the Node
    // proxy's R_PROXY_VALIDATED_PATH_FIELDS allowlist).
    request.body = { operation, params: safeParams, storage_key: resultStorageKey };
  }

  // 2e. Ranked enrichment: only the dedicated validator's fields and the
  // server-allocated output key can cross the worker/R boundary.
  if (spec.carriesEnrichmentParams) {
    const enrichment = args.enrichment;
    const params = enrichment && typeof enrichment === 'object' ? enrichment.params : null;
    const resultStorageKey =
      enrichment && typeof enrichment === 'object' ? enrichment.resultStorageKey : null;
    if (
      !params ||
      typeof params !== 'object' ||
      typeof resultStorageKey !== 'string' ||
      resultStorageKey === ''
    ) {
      throw codedError(
        'R_ENRICHMENT_PARAMS_REQUIRED',
        'Server-validated pathway-enrichment parameters and result key are required.'
      );
    }
    const safeParams = {};
    for (const name of ENRICHMENT_GSEA_PARAM_NAMES) {
      if (Object.prototype.hasOwnProperty.call(params, name)) safeParams[name] = params[name];
    }
    request.body = { operation, params: safeParams, storage_key: resultStorageKey };
  }

  // 2f. CellChat inference: only the dedicated validator's fixed scientific
  // choices and a server-allocated private result key cross this boundary. The
  // caller cannot select a metadata column, database path, R function, or live
  // object state key.
  if (spec.carriesCellChatParams) {
    const cellChat = args.cellChat;
    const params = cellChat && typeof cellChat === 'object' ? cellChat.params : null;
    const resultStorageKey =
      cellChat && typeof cellChat === 'object' ? cellChat.resultStorageKey : null;
    if (
      !params ||
      typeof params !== 'object' ||
      typeof resultStorageKey !== 'string' ||
      resultStorageKey === ''
    ) {
      throw codedError(
        'R_CELLCHAT_PARAMS_REQUIRED',
        'Server-validated cell-communication parameters and result key are required.'
      );
    }
    const safeParams = {};
    for (const name of CELLCHAT_INFERENCE_PARAM_NAMES) {
      if (Object.prototype.hasOwnProperty.call(params, name)) safeParams[name] = params[name];
    }
    request.body = { operation, params: safeParams, storage_key: resultStorageKey };
  }

  if (spec.carriesExplorationParams) {
    const exploration = args.exploration;
    const params = exploration && typeof exploration === 'object' ? exploration.params : null;
    if (!params || typeof params !== 'object') {
      throw codedError(
        'R_EXPLORATION_PARAMS_REQUIRED',
        'Server-validated exploratory-analysis parameters are required.'
      );
    }
    const safeParams = {};
    for (const name of EXPLORATORY_ANALYSIS_PARAM_NAMES) {
      if (Object.prototype.hasOwnProperty.call(params, name)) safeParams[name] = params[name];
    }
    request.body = { operation, params: safeParams };
  }

  if (spec.carriesConditionComparison) {
    const comparison = args.conditionComparison;
    const design = comparison && comparison.design;
    const contrast = design && design.contrast;
    const samples = design && design.samples;
    const resultStorageKey = comparison && comparison.resultStorageKey;
    if (
      !contrast ||
      !Array.isArray(samples) ||
      samples.length < 4 ||
      samples.length > 1000 ||
      typeof resultStorageKey !== 'string' ||
      resultStorageKey === ''
    ) {
      throw codedError(
        'R_CONDITION_COMPARISON_REQUIRED',
        'Server-resolved condition comparison is required.'
      );
    }
    if (
      contrast.blockingFactor ||
      (Array.isArray(contrast.covariates) && contrast.covariates.length > 0)
    ) {
      throw codedError(
        'R_CONDITION_MODEL_UNSUPPORTED',
        'Unsupported condition-model terms cannot cross the trusted R boundary.'
      );
    }
    request.body = {
      operation,
      design: {
        unit_of_replication: contrast.unitOfReplication,
        paired: contrast.paired === true,
        model_formula: contrast.paired === true ? '~ donor + condition' : '~ condition',
        cell_type_column: contrast.cellTypeColumn,
        samples: samples.map((sample) => ({
          sample_id: sample.sampleId,
          condition: sample.condition,
          donor_code: sample.donorCode,
          unit_id: sample.unitId,
          cell_metadata_column: sample.cellMetadataColumn,
          cell_metadata_value: sample.cellMetadataValue,
        })),
      },
      storage_key: resultStorageKey,
    };
  }

  // 2g. Dataset-backed Seurat pipeline op: body reconstructed from ONLY
  // server-validated params and DB-resolved storage coordinates.
  if (spec.carriesSeuratDatasetParams) {
    const seurat = args.seuratPipeline;
    const params = seurat && typeof seurat === 'object' ? seurat.params : null;
    const datasetStorageKey =
      seurat && typeof seurat === 'object' ? seurat.datasetStorageKey : null;
    const datasetFileType = seurat && typeof seurat === 'object' ? seurat.datasetFileType : null;
    const checkpointStorageKey =
      seurat && typeof seurat === 'object' ? seurat.checkpointStorageKey : null;
    if (
      !params ||
      typeof params !== 'object' ||
      typeof datasetStorageKey !== 'string' ||
      datasetStorageKey === '' ||
      typeof datasetFileType !== 'string' ||
      datasetFileType === '' ||
      typeof checkpointStorageKey !== 'string' ||
      checkpointStorageKey === ''
    ) {
      throw codedError(
        'R_SEURAT_PIPELINE_PARAMS_REQUIRED',
        'Server-validated Seurat pipeline parameters and storage keys are required.'
      );
    }
    const safeParams = {};
    for (const name of SEURAT_PIPELINE_PARAM_NAMES) {
      if (Object.prototype.hasOwnProperty.call(params, name)) safeParams[name] = params[name];
    }
    request.body = {
      operation,
      params: safeParams,
      dataset_storage_key: datasetStorageKey,
      dataset_file_type: datasetFileType,
      storage_key: checkpointStorageKey,
    };
  }

  if (spec.carriesMultiSampleSeuratParams) {
    const multi = args.multiSampleSeuratPipeline;
    const params = multi && typeof multi === 'object' ? multi.params : null;
    const inputs = multi && Array.isArray(multi.inputs) ? multi.inputs : null;
    const checkpointStorageKey =
      multi && typeof multi === 'object' ? multi.checkpointStorageKey : null;
    if (
      !params ||
      typeof params !== 'object' ||
      !inputs ||
      inputs.length < 2 ||
      inputs.length > 48 ||
      typeof checkpointStorageKey !== 'string' ||
      checkpointStorageKey === ''
    ) {
      throw codedError(
        'R_MULTI_SAMPLE_SEURAT_PARAMS_REQUIRED',
        'Server-validated multi-sample Seurat parameters and storage keys are required.'
      );
    }
    const safeParams = {};
    for (const name of SEURAT_PIPELINE_PARAM_NAMES) {
      if (Object.prototype.hasOwnProperty.call(params, name)) safeParams[name] = params[name];
    }
    const datasetInputs = inputs.map((input) => {
      if (
        !input ||
        typeof input !== 'object' ||
        typeof input.datasetStorageKey !== 'string' ||
        input.datasetStorageKey === '' ||
        input.datasetFileType !== 'tenx_h5' ||
        typeof input.sampleName !== 'string' ||
        input.sampleName === '' ||
        typeof input.conditionName !== 'string' ||
        input.conditionName === ''
      ) {
        throw codedError(
          'R_MULTI_SAMPLE_SEURAT_PARAMS_REQUIRED',
          'Server-validated multi-sample Seurat parameters and storage keys are required.'
        );
      }
      return {
        storage_key: input.datasetStorageKey,
        file_type: input.datasetFileType,
        sample_name: input.sampleName,
        condition_name: input.conditionName,
        donor_code: input.donorCode || null,
        batch: input.batch || null,
      };
    });
    request.body = {
      operation,
      params: safeParams,
      dataset_inputs: datasetInputs,
      storage_key: checkpointStorageKey,
    };
  }

  if (spec.carriesSpatialDatasetParams) {
    const spatial = args.spatialPipeline;
    const params = spatial && typeof spatial === 'object' ? spatial.params : null;
    const datasetStorageKey =
      spatial && typeof spatial === 'object' ? spatial.datasetStorageKey : null;
    const datasetFileType = spatial && typeof spatial === 'object' ? spatial.datasetFileType : null;
    const checkpointStorageKey =
      spatial && typeof spatial === 'object' ? spatial.checkpointStorageKey : null;
    if (
      !params ||
      typeof params !== 'object' ||
      typeof datasetStorageKey !== 'string' ||
      datasetStorageKey === '' ||
      datasetFileType !== 'visium_zip' ||
      typeof checkpointStorageKey !== 'string' ||
      checkpointStorageKey === ''
    ) {
      throw codedError(
        'R_SPATIAL_PIPELINE_PARAMS_REQUIRED',
        'Server-validated spatial pipeline parameters and storage keys are required.'
      );
    }
    const safeParams = {};
    for (const name of SEURAT_PIPELINE_PARAM_NAMES) {
      if (Object.prototype.hasOwnProperty.call(params, name)) safeParams[name] = params[name];
    }
    request.body = {
      operation,
      params: safeParams,
      dataset_storage_key: datasetStorageKey,
      dataset_file_type: datasetFileType,
      storage_key: checkpointStorageKey,
    };
  }

  // Every real output/live-state worker operation carries one deterministic,
  // server-derived receipt binding. R writes this receipt only after its atomic
  // output or live-state mutation succeeds. Raw job parameters are never read
  // for any binding field.
  const completionReceipt = buildCompletionReceiptBinding(job, operation, args);
  if (completionReceipt) {
    if (!request.body || typeof request.body !== 'object') {
      throw codedError(
        'R_COMPLETION_RECEIPT_CONTEXT_REQUIRED',
        'Completion receipt context is invalid.'
      );
    }
    request.body.completion_receipt = completionReceipt;
  }

  if (logger && typeof logger.info === 'function') {
    // NB: never log the state key (an R state key); only the safe method/path.
    logger.info(
      `[r-bridge] running allowlisted operation '${operation}' (${spec.method} ${spec.path}).`
    );
  }

  // 3. Persist the no-safe-retry boundary immediately before the actual HTTP
  // dispatch. A process crash after this point must become receipt-only recovery,
  // never a second scientific execution. The callback is claim-guarded by the DB.
  if (completionReceipt) {
    if (typeof args.markRDispatchStarted !== 'function') {
      throw codedError(
        'R_DISPATCH_MARKER_REQUIRED',
        'Receipt-backed R dispatch could not be marked safely.'
      );
    }
    await args.markRDispatchStarted();
  }

  // Call R, mapping any failure to a sanitized, coded error. Transport failures,
  // malformed successes, and server errors remain side-effect-possible after the
  // durable marker. A completed 400 response is the reviewed endpoint contract for
  // pre-write input rejection and therefore cannot have published output/receipt.
  let response;
  try {
    response = await callR(request);
  } catch (err) {
    const safe = sanitizeRBridgeError(err);
    // Server-side diagnostic: the low-level code (timeout/ECONNREFUSED/etc.) for the
    // operation. Never the raw error text; the thrown/public message stays sanitized.
    if (logger && typeof logger.warn === 'function') {
      logger.warn(
        `[r-bridge] operation '${operation}' (${spec.method} ${spec.path}) call failed: ${safe.code}.`
      );
    }
    const bridgeError = codedError(safe.code, safe.message);
    throw completionReceipt ? markRSideEffectsPossible(bridgeError) : bridgeError;
  }

  if (!response || response.status !== 200) {
    // Never include the raw body/status text — only a generic, stable message.
    let failCode = 'R_RUNTIME_CHECK_FAILED';
    if (spec.carriesParams) failCode = 'R_PBMC_PIPELINE_FAILED';
    else if (spec.carriesCheckpointSave) failCode = 'R_CHECKPOINT_SAVE_FAILED';
    else if (spec.carriesCheckpoint) failCode = 'R_CHECKPOINT_LOAD_FAILED';
    else if (spec.carriesDegParams) failCode = 'R_DEG_FIND_MARKERS_FAILED';
    else if (spec.carriesEnrichmentParams) failCode = 'R_ENRICHMENT_GSEA_FAILED';
    else if (spec.carriesCellChatParams) failCode = 'R_CELLCHAT_INFERENCE_FAILED';
    else if (spec.carriesExplorationParams) failCode = 'R_EXPLORATION_FAILED';
    else if (spec.carriesConditionComparison) failCode = 'R_CONDITION_COMPARISON_FAILED';
    else if (spec.carriesSeuratDatasetParams) failCode = 'R_SEURAT_PIPELINE_FAILED';
    else if (spec.carriesMultiSampleSeuratParams)
      failCode = 'R_MULTI_SAMPLE_SEURAT_PIPELINE_FAILED';
    else if (spec.carriesSpatialDatasetParams) failCode = 'R_SPATIAL_PIPELINE_FAILED';
    else if (spec.requiresObjectContext) failCode = 'R_OBJECT_INSPECT_FAILED';
    // Server-side diagnostic: the R HTTP status + our coded reason (never the R body,
    // which the R endpoint already logs in full to its own stderr). Pairs with the
    // plumber-side message() so a failure is traceable across both processes.
    const rStatus = response ? response.status : null;
    const rCode = sanitizeRDiagnosticCode(response && response.body && response.body.code);
    if (logger && typeof logger.warn === 'function') {
      logger.warn(
        `[r-bridge] operation '${operation}' (${spec.method} ${spec.path}) got R status ${rStatus || 'none'}${rCode ? ` (${rCode})` : ''} -> ${failCode}.`
      );
    }
    const err = codedError(failCode, sanitizeRBridgeError({ code: failCode }).message);
    err.rStatus = rStatus;
    err.rCode = rCode;
    const preWriteInputRejection = rStatus === 400;
    throw completionReceipt && !preWriteInputRejection ? markRSideEffectsPossible(err) : err;
  }

  // 4. Build SAFE, metadata-only artifact metadata. Only a small, sanitized allowlist
  //    of fields is kept; everything else from the R response is dropped.
  if (completionReceipt && !isPlainObject(response.body)) {
    throw markRSideEffectsPossible(
      codedError('R_RESPONSE_INVALID', 'R runtime returned an invalid response.')
    );
  }
  const body = response.body && typeof response.body === 'object' ? response.body : {};

  if (operation === 'r.pbmc.pipeline.v1') {
    // The bridge returns the SANITIZED pieces the worker needs; the worker (not the
    // bridge) writes the DB result object + artifacts. checkpoint carries only save
    // success + integrity (checksum/size) — never the storage path/key.
    const summary = sanitizePipelineSummary(body);
    const checkpoint = sanitizeCheckpointInfo(body);
    if (checkpoint.saved === true && !checkpoint.checksumSha256) {
      throw markRSideEffectsPossible(
        codedError('R_RESPONSE_INVALID', 'R runtime returned an invalid response.')
      );
    }
    return {
      operation,
      artifactType: spec.artifactType, // 'pipeline_summary'
      name: spec.artifactName,
      description: spec.artifactDescription,
      resultObjectType: 'seurat',
      parentObjectId: objectContext.objectId,
      summary,
      checkpoint,
      // Metadata for the metadata-only pipeline_summary artifact (resolved params are
      // added by the worker, which holds the validated set).
      metadata: {
        operation,
        kind: 'pipeline',
        scientific_output: true,
        ranAt: new Date().toISOString(),
        objectId: objectContext.objectId,
        summary,
      },
    };
  }

  if (operation === 'r.checkpoint.load.v1') {
    // The bridge returns the SANITIZED load summary the worker needs; the worker (not
    // the bridge) writes the metadata-only checkpoint_load artifact. The summary carries
    // only load success + verification + a bounded object summary — never the storage
    // path/key (the worker already holds it internally and keeps it private).
    const loaded = sanitizeLoadSummary(body);
    if (
      loaded.loaded === true &&
      (loaded.checksumVerified !== true || !loaded.runtimeInstanceHash)
    ) {
      throw markRSideEffectsPossible(
        codedError('R_RESPONSE_INVALID', 'R runtime returned an invalid response.')
      );
    }
    return {
      operation,
      artifactType: spec.artifactType, // 'checkpoint_load'
      storageKind: 'metadata_only',
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: objectContext.objectId,
      loaded,
      metadata: {
        operation,
        kind: 'checkpoint_load',
        scientific_output: false,
        live_state_mutation: true,
        loadedAt: new Date().toISOString(),
        // The analysis object id is a normal member-visible resource id — NOT the R
        // state key (the state key is never placed in metadata).
        objectId: objectContext.objectId,
        loaded,
      },
    };
  }

  if (operation === 'r.deg.find_markers.v1') {
    // The bridge returns the SANITIZED pieces the worker needs; the worker (not the bridge)
    // writes the DB artifacts. `result` carries only file save success + integrity
    // (checksum/size/rows) — never the storage path/key. `summary` is a bounded, safe-column
    // marker summary. Resolved params are added by the worker (which holds the validated set).
    const summary = sanitizeDegSummary(body);
    const result = sanitizeDegResultInfo(body);
    if (result.saved === true && !result.checksumSha256) {
      throw markRSideEffectsPossible(
        codedError('R_RESPONSE_INVALID', 'R runtime returned an invalid response.')
      );
    }
    return {
      operation,
      artifactType: spec.artifactType, // 'deg_summary'
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: objectContext.objectId,
      summary,
      result,
      metadata: {
        operation,
        kind: 'deg_summary',
        scientific_output: true,
        downloadable: false,
        ranAt: new Date().toISOString(),
        // The analysis object id is a normal member-visible resource id — NOT the R state key.
        objectId: objectContext.objectId,
        summary,
      },
    };
  }

  if (operation === 'r.checkpoint.save.v1') {
    const summary = sanitizePipelineSummary(body);
    const checkpoint = sanitizeCheckpointInfo(body);
    if (checkpoint.saved === true && !checkpoint.checksumSha256) {
      throw markRSideEffectsPossible(
        codedError('R_RESPONSE_INVALID', 'R runtime returned an invalid response.')
      );
    }
    return {
      operation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      resultObjectType: 'seurat',
      parentObjectId: objectContext.objectId,
      summary,
      checkpoint,
      metadata: {
        operation,
        kind: 'checkpoint_save',
        scientific_output: true,
        savedAt: new Date().toISOString(),
        objectId: objectContext.objectId,
        summary,
      },
    };
  }

  if (operation === 'r.checkpoint.hydrate.v1') {
    const loaded = sanitizeLoadSummary(body);
    if (loaded.loaded !== true || loaded.checksumVerified !== true || !loaded.runtimeInstanceHash) {
      throw codedError('R_RESPONSE_INVALID', 'R runtime returned an invalid response.');
    }
    return { operation, loaded };
  }

  if (operation === 'r.explore.summarize.v1') {
    const summary = sanitizeExplorationSummary(body);
    if (summary.panels.length === 0) {
      throw codedError('R_RESPONSE_INVALID', 'R runtime returned an invalid response.');
    }
    return {
      operation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      summary,
      metadata: {
        operation,
        kind: 'exploration_summary',
        scientific_output: true,
        aggregate_only: true,
        summary,
      },
    };
  }

  if (operation === 'r.enrichment.gsea.v1') {
    const summary = sanitizeEnrichmentSummary(body);
    const result = sanitizeEnrichmentResultInfo(body);
    if (
      result.saved === true &&
      (!result.checksumSha256 || result.sizeBytes === null || result.nRows === null)
    ) {
      throw markRSideEffectsPossible(
        codedError('R_RESPONSE_INVALID', 'R runtime returned an invalid response.')
      );
    }
    return {
      operation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: objectContext.objectId,
      summary,
      result,
      metadata: {
        operation,
        kind: 'enrichment_summary',
        scientific_output: true,
        downloadable: false,
        ranAt: new Date().toISOString(),
        objectId: objectContext.objectId,
        summary,
      },
    };
  }

  if (operation === 'r.condition.pseudobulk_de.v1') {
    const summary = sanitizeConditionComparisonSummary(body);
    const result = sanitizeEnrichmentResultInfo(body);
    if (
      result.saved === true &&
      (!result.checksumSha256 || result.sizeBytes === null || result.nRows === null)
    ) {
      throw markRSideEffectsPossible(
        codedError('R_RESPONSE_INVALID', 'R runtime returned an invalid response.')
      );
    }
    return {
      operation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: objectContext.objectId,
      summary,
      result,
      metadata: {
        operation,
        kind: 'condition_de_summary',
        scientific_output: true,
        downloadable: false,
        ranAt: new Date().toISOString(),
        objectId: objectContext.objectId,
        summary,
      },
    };
  }

  if (operation === 'r.cellchat.infer.v1') {
    const summary = sanitizeCellChatSummary(body);
    const result = sanitizeCellChatResultInfo(body);
    if (
      !isCompleteCellChatSummary(summary) ||
      (result.saved === true &&
        (!result.checksumSha256 || result.sizeBytes === null || result.nRows === null))
    ) {
      throw markRSideEffectsPossible(
        codedError('R_RESPONSE_INVALID', 'R runtime returned an invalid response.')
      );
    }
    return {
      operation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: objectContext.objectId,
      summary,
      result,
      metadata: {
        operation,
        kind: 'cellchat_summary',
        scientific_output: true,
        downloadable: false,
        ranAt: new Date().toISOString(),
        objectId: objectContext.objectId,
        summary,
      },
    };
  }

  if (operation === 'r.seurat.pipeline.v1' || operation === 'r.seurat.multisample.v1') {
    const summary = sanitizePipelineSummary(body);
    const checkpoint = sanitizeCheckpointInfo(body);
    if (checkpoint.saved === true && !checkpoint.checksumSha256) {
      throw markRSideEffectsPossible(
        codedError('R_RESPONSE_INVALID', 'R runtime returned an invalid response.')
      );
    }
    return {
      operation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      resultObjectType: 'seurat',
      summary,
      checkpoint,
      metadata: {
        operation,
        kind: 'pipeline',
        scientific_output: true,
        ranAt: new Date().toISOString(),
        summary,
        warnings: sanitizeNameList(body.warnings, 32, 160),
      },
    };
  }

  if (operation === 'r.spatial.seurat.v1') {
    const summary = sanitizePipelineSummary(body);
    const checkpoint = sanitizeCheckpointInfo(body);
    if (checkpoint.saved === true && !checkpoint.checksumSha256) {
      throw markRSideEffectsPossible(
        codedError('R_RESPONSE_INVALID', 'R runtime returned an invalid response.')
      );
    }
    return {
      operation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      resultObjectType: 'seurat',
      summary,
      checkpoint,
      metadata: {
        operation,
        kind: 'spatial_pipeline',
        modality: 'spatial',
        scientific_output: true,
        ranAt: new Date().toISOString(),
        summary,
        warnings: sanitizeNameList(body.warnings, 32, 160),
      },
    };
  }

  if (operation === 'r.object.inspect') {
    const metadata = {
      operation,
      kind: 'inspection',
      scientific_output: false,
      read_only: true,
      inspectedAt: new Date().toISOString(),
      // The analysis object id is a normal (already member-visible) resource id, NOT
      // the R state key — the state key is never placed in metadata.
      objectId: objectContext.objectId,
      object: sanitizeInspectionSummary(body),
    };
    return {
      operation,
      artifactType: spec.artifactType,
      storageKind: 'metadata_only',
      name: spec.artifactName,
      description: spec.artifactDescription,
      metadata,
    };
  }

  // r.runtime.check
  const runtime = {};
  const status = sanitizeRuntimeField(body.status);
  const mode = sanitizeRuntimeField(body.mode);
  if (status) runtime.status = status;
  if (mode) runtime.mode = mode;

  const metadata = {
    operation,
    kind: 'operational',
    scientific_output: false,
    checkedAt: new Date().toISOString(),
    runtime,
  };

  return {
    operation,
    artifactType: spec.artifactType,
    storageKind: 'metadata_only',
    name: spec.artifactName,
    description: spec.artifactDescription,
    metadata,
  };
}

module.exports = {
  DEFAULT_R_BRIDGE_TIMEOUT_MS,
  MAX_R_BRIDGE_TIMEOUT_MS,
  MAX_CELLCHAT_RESULT_ROWS,
  R_BRIDGE_OPERATIONS,
  R_BRIDGE_ALLOWED_TARGETS,
  isAllowedRBridgeOperation,
  isAllowedRBridgeTarget,
  sanitizeRuntimeField,
  sanitizeCount,
  sanitizeNameList,
  sanitizeInspectionSummary,
  sanitizeChecksum,
  sanitizePipelineSummary,
  sanitizeCheckpointInfo,
  sanitizeLoadSummary,
  sanitizeExplorationSummary,
  sanitizeStatNumber,
  sanitizeDegSummary,
  sanitizeDegResultInfo,
  sanitizeEnrichmentSummary,
  sanitizeEnrichmentResultInfo,
  sanitizeConditionComparisonSummary,
  sanitizeCellChatGroup,
  sanitizeCellChatSummary,
  sanitizeCellChatResultInfo,
  createCompletionReceiptEnvelope,
  verifyCompletionReceiptEnvelope,
  buildCompletionReceiptBinding,
  descriptorFromCompletionReceipt,
  sanitizeRBridgeError,
  createDefaultRCaller,
  runRBridgeOperation,
};
