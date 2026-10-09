'use strict';

const projection = require('./executionHistoryProjection');
const { LIMITS, HEX, ID, parse, timestamp, safeText, safeId, boundedJSON, sourceRecord, reference, jobKind, summary } = projection;
const storage = require('./storage');
const executionTargets = require('./executionTargets');
const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const KINDS = new Set(['all', 'guided', 'workflow', 'expert-r', 'live-r', 'r-console', 'provenance']);
function historyError(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
const missing = () => historyError('EXECUTION_RECORD_NOT_FOUND', 'Execution record not found.', 404);
function identityInput(id, name, basis) { return { name, analysisObjectId: safeId(id), precision: 'identity-only', basis, reference: null }; }
function addGap(issues, code, message) { if (!issues.some(item => item.code === code)) issues.push({ code, message }); }
function consoleOutcome(row) { return row.status==='failed'&&row.result_json?.interrupted===true&&row.result_json?.error?.code==='PRIVATE_KERNEL_INTERRUPTED'?'interrupted':null; }

function createExecutionHistoryService(db, provider = storage.createLocalStorageProvider()) {
  async function list(userId, projectId, options = {}) {
    await db.requireProjectRole(userId, projectId, READ_ROLES);
    const limit = Number(options.limit ?? 25); const kind = options.kind || 'all';
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.page || !KINDS.has(kind)) throw historyError('INVALID_HISTORY_PAGE', 'Choose 1–50 history records and a supported execution category.');
    let cursor;
    if (options.before) {
      try {
        if (typeof options.before !== 'string' || options.before.length > 256) throw new Error();
        cursor = JSON.parse(Buffer.from(options.before, 'base64url').toString('utf8'));
        if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || cursor[0].length > 40 || !timestamp(cursor[0]) || !ID.test(cursor[1])) throw new Error();
      } catch { throw historyError('INVALID_HISTORY_PAGE', 'Execution history cursor is invalid.'); }
    }
    const time = "date_trunc('milliseconds',r.created_at)";
    const cursorClause = cursor ? ` AND (${time},r.id)<($4::timestamptz,$5::text)` : '';
    const parameters = [projectId, userId, limit + 1, ...(cursor || [])];
    const rows = await Promise.all([
      ['all', 'guided', 'workflow', 'expert-r'].includes(kind) ? db.query(`SELECT r.id,r.project_id,r.owner_user_id,r.job_type,r.status,r.created_at,r.started_at,r.completed_at,u.display_name,
        CASE WHEN r.owner_user_id=$2 AND w.job_id IS NOT NULL THEN 'workflow' WHEN r.job_type='expert.r.v1' THEN 'expert-r' ELSE 'guided' END AS kind
        FROM jobs r JOIN users u ON u.id=r.owner_user_id LEFT JOIN workflow_runs w ON w.job_id=r.id
        WHERE r.project_id=$1${kind === 'all' ? '' : ` AND (CASE WHEN r.owner_user_id=$2 AND w.job_id IS NOT NULL THEN 'workflow' WHEN r.job_type='expert.r.v1' THEN 'expert-r' ELSE 'guided' END)='${kind}'`}${cursorClause}
        ORDER BY ${time} DESC,r.id DESC LIMIT $3`, parameters).then(result => result.rows.map(row => summary(row, row.kind, Number(row.owner_user_id) === Number(userId), row.display_name))) : [],
      ['all', 'live-r'].includes(kind) ? db.query(`SELECT r.id,r.project_id,r.owner_user_id,r.operation,r.created_at,u.display_name FROM live_execution_records r JOIN users u ON u.id=r.owner_user_id WHERE r.project_id=$1 AND r.owner_user_id=$2${cursorClause} ORDER BY ${time} DESC,r.id DESC LIMIT $3`, parameters).then(result => result.rows.map(row => summary(row, 'live-r', true, row.display_name))) : [],
      ['all','r-console'].includes(kind) ? db.query(`SELECT r.id,r.project_id,r.owner_user_id,r.status,r.created_at,r.started_at,r.completed_at,(r.status='failed' AND r.result_json->'interrupted'='true'::jsonb AND r.result_json->'error'->>'code'='PRIVATE_KERNEL_INTERRUPTED') AS interrupted,u.display_name FROM private_r_executions r JOIN users u ON u.id=r.owner_user_id WHERE r.project_id=$1 AND r.owner_user_id=$2${cursorClause} ORDER BY ${time} DESC,r.id DESC LIMIT $3`,parameters).then(result=>result.rows.map(row=>({...summary({...row,operation:'Free R console command'},'r-console',true,row.display_name),status:row.status,...(row.interrupted===true?{outcome:'interrupted'}:{})}))) : [],
      ['all', 'provenance'].includes(kind) ? db.query(`SELECT r.id,r.project_id,r.created_by_user_id,r.operation,r.created_at,u.display_name FROM provenance r JOIN users u ON u.id=r.created_by_user_id WHERE r.project_id=$1 AND r.created_by_user_id=$2 AND r.job_id IS NULL${cursorClause} ORDER BY ${time} DESC,r.id DESC LIMIT $3`, parameters).then(result => result.rows.map(row => summary(row, 'provenance', true, row.display_name))) : [],
    ]);
    const all = rows.flat().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const items = all.slice(0, limit); const last = items.at(-1);
    await db.requireProjectRole(userId, projectId, READ_ROLES);
    return { items, nextCursor: all.length > limit ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString('base64url') : null };
  }

  async function ownedRecord(userId, projectId, recordId) {
    await db.requireProjectRole(userId, projectId, READ_ROLES);
    if (!safeId(recordId)) throw missing();
    if(recordId.startsWith('pex_')) {
      const consoleRecord=(await db.query(`SELECT e.*,k.environment_json,k.environment_manifest_json,k.inputs_json,k.resources_json,k.target_json,k.workspace_id,k.restarted_from_kernel_id,k.analysis_object_id AS kernel_analysis_object_id FROM private_r_executions e JOIN private_r_kernels k ON k.id=e.kernel_id WHERE e.id=$1 AND e.project_id=$2 AND e.owner_user_id=$3 AND k.owner_user_id=$3`,[recordId,projectId,userId])).rows[0];
      if(consoleRecord)return {kind:'r-console',row:consoleRecord};throw missing();
    }
    const jobs = await db.query('SELECT * FROM jobs WHERE id=$1 AND project_id=$2 AND owner_user_id=$3', [recordId, projectId, userId]);
    if (jobs.rows[0]) return { kind: 'job', row: jobs.rows[0] };
    const live = await db.query('SELECT * FROM live_execution_records WHERE id=$1 AND project_id=$2 AND owner_user_id=$3', [recordId, projectId, userId]);
    if (live.rows[0]) return { kind: 'live-r', row: live.rows[0] };
    const provenance = await db.query('SELECT * FROM provenance WHERE id=$1 AND project_id=$2 AND created_by_user_id=$3 AND job_id IS NULL', [recordId, projectId, userId]);
    if (provenance.rows[0]) return { kind: 'provenance', row: provenance.rows[0] };
    throw missing();
  }
  async function environmentEvidence(metadata, issues, provenance = null, parameters = {}) {
    const evidenceMetadata = [...metadata, parameters];
    const value = evidenceMetadata.find(item => item.environment)?.environment;
    if (value) {
      try {
        const validated = require('./rEnvironment').validateEnvironmentReference(value);
        const artifact = metadata.map(item => item.environmentArtifact).find(item => item && safeId(item.id) && HEX.test(item.checksumSha256 || '') && item.checksumSha256 === validated.manifestSha256 && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes > 0 && item.sizeBytes <= LIMITS.detailBytes);
        const manifestReference = artifact ? { versionId: artifact.id, sha256: artifact.checksumSha256, sizeBytes: artifact.sizeBytes } : null;
        return { precision: 'pinned-reference', reference: validated, manifestReference, manifestAvailable: Boolean(manifestReference), observed: null, note: 'Pinned container userspace environment; inspect its retained manifest to verify exact bytes. Host kernel and hardware are outside this snapshot.' };
      } catch { addGap(issues, 'environment-inconsistent', 'The retained environment reference is unavailable or inconsistent.'); }
    }
    const image = evidenceMetadata.find(item => HEX.test(String(item.sandboxImageDigest || '').replace(/^sha256:/, '')));
    const profileId = evidenceMetadata.map(item => item.packageProfileId || item.profileId).find(value => safeId(value));
    addGap(issues, 'environment-not-pinned', 'An exact R/package/system environment manifest was not retained for this execution.');
    const observed = projection.observedRuntimeMetadata(metadata);
    if (observed) return { precision: 'observed-metadata', reference: null, manifestAvailable: false, observed,
      note: 'Runtime versions were returned during this worker run. They are bounded observations, not an exact restorable environment snapshot.' };
    if (provenance && typeof provenance.language_version === 'string' && /^\d+\.\d+\.\d+$/.test(provenance.language_version)) {
      const packages = parse(provenance.packages, []);
      return { precision: 'declared-metadata', reference: null, manifestAvailable: false,
        observed: { rVersion: provenance.language_version, packages: Array.isArray(packages) ? packages.slice(0, 100)
          .filter(name => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,79}$/.test(name)).map(name => ({ name, version: null })) : [] },
        note: 'Versions and package names were supplied through provenance metadata. They do not verify the worker environment.' };
    }
    return { precision: image ? 'recorded-image' : profileId ? 'declared-profile' : 'unavailable', reference: null, manifestAvailable: false, observed: { profileId: profileId || null, imageDigest: image ? image.sandboxImageDigest : null }, note: 'Recorded profiles or image identifiers alone do not provide a complete environment manifest.' };
  }
  function output(row, projectId) {
    const value = reference(projectId, row.id, row.checksum_sha256, row.size_bytes, safeText(row.name) || safeText(row.artifact_type) || 'Output', 'Published job artifact');
    return { ...value, type: safeText(row.artifact_type), status: safeText(row.status), inspectable: Boolean(value.reference && row.status === 'available' && row.storage_kind === 'local_internal'), metadataOnly: row.storage_kind === 'metadata_only' };
  }
  async function workflowEvidence(userId, projectId, row, link, outputs, issues) {
    const instance = link.instance_id ? (await db.query('SELECT id,package_digest,package_json,state_json FROM workflow_instances WHERE id=$1 AND project_id=$2 AND owner_user_id=$3', [link.instance_id, projectId, userId])).rows[0] : null;
    const snapshots = (await db.query(`SELECT id,package_digest,package_json,state_json FROM workflow_snapshots WHERE project_id=$1 AND owner_user_id=$2 AND state_json->'results'->$3 IS NOT NULL ORDER BY created_at DESC LIMIT $4`, [projectId, userId, link.step_id, LIMITS.snapshots])).rows;
    const outputIds = new Set(outputs.map(output => output.id));
    let pinned = instance; let execution;
    for (const candidate of [instance, ...snapshots].filter(Boolean)) {
      if (candidate.state_json.active?.id === row.id && candidate.state_json.active.generation === link.generation) { pinned = candidate; execution = candidate.state_json.active; break; }
      const result = candidate.state_json.results?.[link.step_id];
      if (result && Object.keys(result.outputs || {}).length && Object.values(result.outputs).every(item => outputIds.has(item.id))) { pinned = candidate; execution = result; break; }
    }
    const step = pinned?.package_json?.steps?.find(step => step.id === link.step_id);
    const source = sourceRecord(step ? pinned.package_json.files?.[step.entry] : null, null);
    if (pinned && require('./workflowRuntime').digest(pinned.package_json) !== pinned.package_digest) {
      source.code = null; source.precision = 'inconsistent'; source.note = 'The retained recipe does not match its recorded package checksum.';
      addGap(issues, 'workflow-package-inconsistent', source.note);
    }
    if (execution && source.code) {
      const recordedHash = parse(row.parameters_json).scriptSha256 || execution.runtime?.scriptSha256;
      let compiledHash;
      try { compiledHash = projection.digest(require('./workflowRuntime').compileStep(pinned.package_json, { active: { ...execution, stepId: link.step_id } }).script); } catch { /* Corrupt historical packages are evidence gaps, not runnable inputs. */ }
      if (!HEX.test(recordedHash || '') || compiledHash !== recordedHash) {
        source.code = null; source.precision = 'inconsistent'; source.note = 'The retained recipe execution does not match its recorded compiled-source checksum.';
        addGap(issues, 'workflow-execution-inconsistent', source.note);
      }
    }
    source.package = pinned && HEX.test(pinned.package_digest) ? { id: safeId(pinned.package_json.id), version: safeText(pinned.package_json.version), sha256: pinned.package_digest, stepId: safeId(link.step_id), retainedBy: safeId(pinned.id) } : null;
    source.note = source.note || 'Pinned recipe step body. Wrapper/helper dependencies are represented by the package checksum.';
    if (!execution) addGap(issues, 'workflow-run-snapshot-missing', 'This run no longer has a matching active/result snapshot; its exact resolved step parameters and inputs were not retained. Later workflow state is not substituted.');
    const inputs = execution ? Object.entries(execution.inputs || {}).slice(0, 32).map(([name, input]) => reference(projectId, input.id, input.sha256, input.sizeBytes, name, 'Matching workflow execution snapshot')) : [identityInput(row.analysis_object_id, 'Selected analysis', 'Job identity; consumed checkpoint version unavailable')];
    return { source, inputs, parameters: { precision: execution ? 'resolved-snapshot' : 'unavailable', values: boundedJSON(execution?.parameters || {}).value, seed: Number.isSafeInteger(execution?.seed) ? execution.seed : null }, metadata: execution?.runtime ? [execution.runtime] : [], workflowGeneration: link.generation };
  }

  async function get(userId, projectId, recordId) {
    const { kind: origin, row } = await ownedRecord(userId, projectId, recordId);
    const issues = [];
    const ownerName = (await db.query('SELECT display_name FROM users WHERE id=$1', [userId])).rows[0]?.display_name;
    let detail;
    if(origin==='r-console') {
      const api=require('./rEnvironment');
      let environment;
      try {const manifest=api.validateEnvironmentManifest(row.environment_manifest_json);const exact=api.summarizeEnvironmentManifest(manifest);api.assertEnvironmentMatches(row.environment_json,exact);environment={precision:'pinned-reference',reference:exact,manifestAvailable:true,manifestReference:{versionId:row.kernel_id,sha256:exact.manifestSha256,sizeBytes:api.environmentBytes(manifest).length},observed:null,note:'Pinned private kernel userspace environment. The worker host kernel and hardware remain outside this snapshot.'};}
      catch {environment={precision:'unavailable',reference:null,manifestAvailable:false,observed:null,note:'The retained kernel environment is inconsistent.'};addGap(issues,'environment-inconsistent',environment.note);}
      const inputs=(row.inputs_json||[]).map(input=>({...reference(projectId,input.versionId,input.checksumSha256,input.sizeBytes,input.name,'Exact verified session-start input version'),reference:input.reference,role:input.role}));
      const saved=(await db.query(`SELECT v.* FROM managed_artifact_versions v JOIN private_r_publications p ON p.id=v.source_publication_id WHERE p.source_execution_id=$1 AND p.status='completed' AND p.project_id=$2 AND p.owner_user_id=$3 AND v.owner_user_id=$3 ORDER BY v.created_at,v.id LIMIT $4`,[row.id,projectId,userId,LIMITS.outputs+1])).rows;
      const outputs=saved.slice(0,LIMITS.outputs).map(item=>({...reference(projectId,item.id,item.checksum_sha256,item.size_bytes,item.name,'Explicitly published private R output'),id:item.id,type:item.artifact_type,status:'available',inspectable:true,metadataOnly:false,reference:{artifactId:item.artifact_id,versionId:item.id,projectId,sha256:item.checksum_sha256}}));
      addGap(issues,'unsaved-kernel-state','The selected input versions initialize the session. Intermediate variables, files, external effects, and randomness were not captured as independent artifact versions; source order does not prove a complete replay.');
      if(!outputs.length)addGap(issues,'console-previews-not-artifacts','Bounded console previews are retained in the private command journal. No artifact versions have been explicitly published from this command.');
      if(saved.length>LIMITS.outputs)addGap(issues,'output-inspection-bounded','Only the first 64 explicitly saved output versions are included.');
      if(row.status==='unknown')addGap(issues,'completion-unknown','The runtime connection ended without a confirmed terminal result. This command is not rerun automatically.');
      let target;
      try { target={...executionTargets.validatePrivateKernelTarget(row.target_json),precision:'recorded-service-generation'}; }
      catch { target={kind:'unknown',id:null,precision:'unavailable'};addGap(issues,'physical-target-not-recorded','The private kernel execution target was not retained or is inconsistent. Current connection settings are not substituted.'); }
      detail={...summary({...row,operation:'Free R console command'},'r-console',true,ownerName),status:row.status,...(consoleOutcome(row)?{outcome:consoleOutcome(row)}:{}),origin:'server-private-r-console',source:{...sourceRecord(row.source_code,row.source_sha256),versionId:row.id},inputs,parameters:{precision:'source-defined',values:{},seed:null},environment,target,timestamps:{createdAt:timestamp(row.created_at),recordedAt:timestamp(row.created_at),startedAt:timestamp(row.started_at),completedAt:timestamp(row.completed_at)},outputs,kernel:{available:true,id:row.kernel_id,generation:row.kernel_generation,order:Number(row.execution_order),restartedFromKernelId:row.restarted_from_kernel_id||null,scope:'Creator-private persistent R kernel; command order is local to this generation.'}};
    } else if (origin !== 'job') {
      const journal = origin === 'live-r'; const data = journal ? parse(row.record_json) : {};
      const parameters = boundedJSON(journal ? data.parameters : parse(row.parameters));
      const source = sourceRecord(journal ? data.source?.code : row.script, journal ? row.source_sha256 : null, safeText(journal ? data.source?.language : row.language) || 'R');
      const environmentData = journal ? data.environment : { rVersion: row.language_version, packages: parse(row.packages, []) };
      const packages = Array.isArray(environmentData?.packages) ? environmentData.packages.slice(0, 100).map(item => typeof item === 'string' ? { name: safeText(item), version: null } : { name: safeText(item?.name), version: safeText(item?.version) }).filter(item => item.name) : [];
      addGap(issues, 'live-input-not-versioned', 'Live memory input bytes and earlier unsaved state were not captured as immutable artifact versions.');
      addGap(issues, 'environment-not-pinned', 'Observed R/package metadata is not a restorable OS/runtime snapshot.');
      if (!journal) addGap(issues, 'imported-provenance', 'This provenance was supplied through the project metadata API; it is not a server-verified execution journal.');
      const kernel = journal && HEX.test(row.kernel_generation) && Number.isSafeInteger(Number(row.kernel_order)) && Number(row.kernel_order) > 0 ? { available: true, generation: row.kernel_generation, order: Number(row.kernel_order), resultLiveRevision: row.live_revision == null ? null : Number(row.live_revision), scope: 'Guided interactive R process; order is global within that process.' } : { available: false, reason: 'Kernel generation and execution order were not retained.' };
      let target={kind:'unknown',id:null,precision:'unavailable'};
      if(journal) {
        try { target=executionTargets.validateExecutionTarget(data.target); }
        catch {
          if(data.target?.kind==='service'&&data.target.id==='interactive-r'&&data.target.precision==='service-process')target={kind:'service',id:'interactive-r',precision:'service-process'};
          addGap(issues,'physical-target-not-recorded','The installation/executor identity was not retained for this interactive execution. Current connection settings are not substituted.');
        }
      }
      detail = { ...summary(row, origin, true, ownerName), origin: journal ? 'server-live-r' : 'imported-provenance', source, inputs: [identityInput(row.analysis_object_id, 'Live analysis object', 'Live memory identity; consumed bytes unavailable')], parameters: { precision: journal ? 'recorded-resolved' : 'imported-declared', values: parameters.value, seed: null }, environment: { precision: 'observed-metadata', reference: null, manifestAvailable: false, observed: { rVersion: safeText(environmentData?.rVersion), packages }, note: 'Package names without versions are marked unknown.' }, target, timestamps: { createdAt: timestamp(row.created_at), recordedAt:timestamp(journal ? data.timestamp : row.timestamp), startedAt: null, completedAt: null }, outputs: [], kernel };
      if (parameters.redacted) addGap(issues, 'parameters-redacted', 'Private or oversized parameter details were omitted.');
      addGap(issues, 'outputs-not-published', 'This record does not retain independently inspectable output artifact versions.');
    } else {
      const [links, artifactRows, provenanceRows, workflowRows, sourceRows, receiptRows] = await Promise.all([
        db.query('SELECT * FROM workflow_runs WHERE job_id=$1', [row.id]),
        db.query('SELECT * FROM job_artifacts WHERE job_id=$1 AND project_id=$2 AND created_by_user_id=$3 ORDER BY created_at,id LIMIT $4', [row.id, projectId, userId, LIMITS.outputs + 1]),
        db.query('SELECT * FROM provenance WHERE job_id=$1 AND project_id=$2 AND created_by_user_id=$3 ORDER BY created_at,id LIMIT $4', [row.id, projectId, userId, LIMITS.provenance + 1]),
        db.query('SELECT id,descriptor_json FROM workflow_artifacts WHERE job_id=$1 AND project_id=$2 AND owner_user_id=$3 ORDER BY created_at,id LIMIT $4', [row.id, projectId, userId, LIMITS.outputs + 1]),
        db.query('SELECT id,language,source_code,source_sha256,created_at FROM execution_source_versions WHERE job_id=$1 AND project_id=$2 AND owner_user_id=$3', [row.id, projectId, userId]),
        db.query('SELECT dispatch_id,attempt,operation,dispatch_at,target_json,environment_json FROM job_execution_receipts WHERE job_id=$1 AND project_id=$2 AND owner_user_id=$3 ORDER BY dispatch_order DESC LIMIT $4', [row.id, projectId, userId, 33]),
      ]);
      const link = links.rows[0]; const kind = jobKind(row, link, true);
      const artifacts = artifactRows.rows.slice(0, LIMITS.outputs); const metadata = artifacts.map(item => parse(item.metadata_json));
      const params = parse(row.parameters_json); const provenance = provenanceRows.rows[0];
      let source, inputs, parameters;
      const outputs = artifacts.map(item => output(item, projectId));
      if (link) {
        const evidence = await workflowEvidence(userId, projectId, row, link, workflowRows.rows, issues);
        ({ source, inputs, parameters } = evidence); metadata.push(...evidence.metadata);
        for (const item of workflowRows.rows.slice(0, LIMITS.outputs)) { const descriptor = item.descriptor_json; outputs.push({ ...reference(projectId, item.id, descriptor.sha256, descriptor.sizeBytes, `Workflow ${safeText(descriptor.type) || 'output'}`, 'Published workflow output'), type: safeText(descriptor.type), status: 'available', inspectable: true, metadataOnly: false }); }
      } else {
        source = sourceRecord(kind === 'expert-r' ? params.script : provenance?.script, kind === 'expert-r' ? params.scriptSha256 : null);
        const resolved = metadata.find(item => item.resolvedParams);
        const paramProjection = boundedJSON(resolved?.resolvedParams || (kind === 'expert-r' ? { profileId: params.profileId } : params));
        parameters = { precision: resolved ? 'recorded-resolved' : 'declared-job', values: paramProjection.value, seed: Number.isSafeInteger(resolved?.resolvedParams?.seed) ? resolved.resolvedParams.seed : null };
        if (!resolved && kind !== 'expert-r') addGap(issues, 'parameters-not-resolved', 'Only submitted job parameters were retained; defaults actually used are unavailable.');
        if (paramProjection.redacted) addGap(issues, 'parameters-redacted', 'Private or oversized parameter details were omitted.');
        const input = metadata.find(item => item.input?.checkpointArtifactId)?.input;
        const checkpoint = input || metadata.find(item => item.checkpointArtifactId && item.checksumSha256);
        inputs = checkpoint ? [reference(projectId, checkpoint.checkpointArtifactId, input ? input.checkpointChecksumSha256 : checkpoint.checksumSha256, input ? input.checkpointSizeBytes : checkpoint.sizeBytes, 'Consumed checkpoint', 'Recorded worker input manifest')] : [];
        for (const item of (input?.privateInputs || []).slice(0, 5)) inputs.push(reference(projectId, item.id, item.checksumSha256, item.sizeBytes, 'Private R input', 'Recorded worker input manifest'));
        if (!inputs.length && row.analysis_object_id) inputs.push(identityInput(row.analysis_object_id, 'Selected analysis', 'Job identity; consumed checkpoint version unavailable'));
        if (row.dataset_id) inputs.push({ name: 'Dataset input', datasetId: safeId(row.dataset_id), precision: 'identity-only', basis: 'Job dataset identity; consumed dataset version hash unavailable', reference: null });
        if (kind === 'expert-r' && !input) addGap(issues, 'expert-input-manifest-missing', 'The exact checkpoint/private-input manifest was not retained for this execution. Current inputs are not substituted.');
      }
      const retainedSource = sourceRows.rows[0];
      if (retainedSource) {
        const exact = sourceRecord(retainedSource.source_code, retainedSource.source_sha256, retainedSource.language);
        exact.versionId = safeId(retainedSource.id); exact.retainedAt = timestamp(retainedSource.created_at);
        if (source.package) exact.package = source.package;
        if (params.scriptSha256 && params.scriptSha256 !== retainedSource.source_sha256) { exact.code = null; exact.precision = 'inconsistent'; exact.note = 'The private source version does not match the job’s recorded source checksum.'; }
        source = exact;
      }
      let environment = await environmentEvidence(metadata, issues, provenance, params);
      const executionAttempts = [];
      for (const receipt of receiptRows.rows.slice(0, 32)) {
        try { executionAttempts.push(executionTargets.rowToExecutionReceipt(receipt)); }
        catch { addGap(issues, 'execution-target-inconsistent', 'A retained execution target receipt is inconsistent and cannot be presented as verified evidence.'); }
      }
      const latestReceipt = executionAttempts.find(receipt => receipt.dispatchId === receiptRows.rows[0]?.dispatch_id);
      if (!latestReceipt) addGap(issues, 'physical-target-not-recorded', 'The installation/worker target identity was not retained for this execution. Current connection settings are not substituted.');
      if (receiptRows.rows.length > 32) addGap(issues, 'execution-attempt-inspection-bounded', 'Only the latest 32 execution dispatch receipts are included.');
      if (latestReceipt?.environment.precision === 'pinned-request' && !environment.manifestAvailable) {
        environment = { precision: 'pinned-request', reference: latestReceipt.environment.reference,
          manifestAvailable: false, manifestReference: null, observed: null,
          note: 'This exact environment was requested before dispatch. A verified result environment manifest was not retained.' };
        addGap(issues, 'environment-request-not-verified', 'A pinned request records the expected environment; it does not prove that execution completed in that environment.');
      }
      detail = { ...summary(row, kind, true, ownerName), origin: 'durable-job', source, inputs, parameters, environment,
        target: latestReceipt ? { ...latestReceipt.target, note: 'Retained service and executor identity at dispatch. The runtime generation is an authenticated admission observation before dispatch. It does not identify a physical host or prove which R process completed the request.' }
          : { kind: 'unknown', id: null, precision: 'unavailable', note: 'An execution target was not retained. Current connection settings do not identify this historical execution.' },
        executionAttempts: executionAttempts.reverse(),
        timestamps: { createdAt: timestamp(row.created_at), recordedAt: latestReceipt?.dispatchAt || null, startedAt: timestamp(row.started_at), completedAt: timestamp(row.completed_at || row.canceled_at) }, outputs: outputs.slice(0, LIMITS.outputs), kernel: { available: false, reason: 'One-shot jobs do not retain a persistent kernel generation or command order.' }, retryOf: safeId(row.retry_of_job_id) };
      if (outputs.length > LIMITS.outputs || artifactRows.rows.length > LIMITS.outputs || workflowRows.rows.length > LIMITS.outputs) addGap(issues, 'output-inspection-bounded', 'Only the first 64 output descriptors are included in this bounded view.');
      if (provenanceRows.rows.length > 1) addGap(issues, 'multiple-provenance-records', 'Several provenance records exist; retained source is from the first chronological owner record.');
      if (kind === 'guided' && source.code) addGap(issues, 'source-provenance-unverified', 'Retained provenance source is user-supplied metadata; the exact platform implementation revision was not recorded.');
      if (kind === 'expert-r' && !params.script && !retainedSource) addGap(issues, 'expert-source-retention', 'This legacy Expert R job retains only a source checksum. New submissions retain a separate private source version; a checksum alone cannot reconstruct an older script.');
      if (!outputs.length) addGap(issues, 'outputs-unavailable', 'No durable output artifact descriptor is available for this execution.');
    }
    if (detail.source.precision !== 'exact-retained') addGap(issues, 'source-unavailable', detail.source.note);
    if (!detail.inputs.length || detail.inputs.some(input => !input.reference)) addGap(issues, 'inputs-not-versioned', 'At least one consumed input is recorded only by identity or live state; exact input bytes cannot be inferred.');
    detail.replay = { complete: false, issues };
    await db.requireProjectRole(userId, projectId, READ_ROLES);
    if (Buffer.byteLength(JSON.stringify(detail)) > LIMITS.detailBytes) throw historyError('HISTORY_DETAIL_TOO_LARGE', 'This execution exceeds the bounded history inspection size. Inspect its retained artifacts separately.', 413);
    return detail;
  }

  async function environment(userId, projectId, recordId) {
    const record = await ownedRecord(userId, projectId, recordId);
    if(record.kind==='r-console') {
      try {const api=require('./rEnvironment');const manifest=api.validateEnvironmentManifest(record.row.environment_manifest_json);const reference=api.summarizeEnvironmentManifest(manifest);api.assertEnvironmentMatches(record.row.environment_json,reference);await db.requireProjectRole(userId,projectId,READ_ROLES);return {reference,manifest,integrityVerified:true};}
      catch(error){if(error.code==='NOT_FOUND'||error.code==='PROJECT_ROLE_REQUIRED')throw error;throw historyError('ENVIRONMENT_MANIFEST_INVALID','The retained private kernel environment is inconsistent.',409);}
    }
    if (record.kind !== 'job') throw historyError('ENVIRONMENT_MANIFEST_UNAVAILABLE', 'A verified environment manifest is unavailable for this execution.', 404);
    const rows = (await db.query("SELECT * FROM job_artifacts WHERE project_id=$1 AND job_id=$2 AND created_by_user_id=$3 AND artifact_type='expert_r_environment' AND status='available' AND storage_kind='local_internal' LIMIT 2", [projectId, recordId, userId])).rows;
    if (rows.length !== 1 || Number(rows[0].size_bytes) > LIMITS.detailBytes || !storage.isProjectStorageKey(rows[0].storage_uri, { projectId })) throw historyError('ENVIRONMENT_MANIFEST_UNAVAILABLE', 'A verified environment manifest is unavailable for this execution.', 404);
    let opened;
    try {
      opened = await provider.openVerifiedRead(rows[0].storage_uri, { checksumSha256: rows[0].checksum_sha256, sizeBytes: Number(rows[0].size_bytes) });
      const bytes = Buffer.alloc(LIMITS.detailBytes + 1); let length = 0;
      while (length < bytes.length) { const result = await opened.handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
      if (length > LIMITS.detailBytes) throw new Error();
      const api = require('./rEnvironment'); const manifest = api.validateEnvironmentManifest(JSON.parse(bytes.subarray(0, length).toString('utf8')));
      const reference = api.summarizeEnvironmentManifest(manifest);
      const history = await get(userId, projectId, recordId);
      if (!history.environment.reference) throw new Error();
      const descriptor = history.environment.manifestReference;
      if (!descriptor || descriptor.versionId !== rows[0].id || descriptor.sha256 !== rows[0].checksum_sha256 || descriptor.sizeBytes !== Number(rows[0].size_bytes)) throw new Error();
      api.assertEnvironmentMatches(history.environment.reference, reference);
      await db.requireProjectRole(userId, projectId, READ_ROLES);
      return { reference, manifest, integrityVerified: true };
    } catch (error) {
      if (error.code === 'NOT_FOUND' || error.code === 'PROJECT_ROLE_REQUIRED') throw error;
      throw historyError('ENVIRONMENT_MANIFEST_INVALID', 'The retained environment manifest is missing, changed, or inconsistent with this execution.', 409);
    } finally { if (opened) await opened.handle.close(); }
  }
  return { list, get, environment };
}

module.exports = { createExecutionHistoryService, KINDS, historyError };
