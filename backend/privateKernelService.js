'use strict';

const crypto = require('node:crypto');
const storage = require('./storage');
const config = require('./config');
const { expertRSandboxEnabled } = require('./expertR');
const { expertRAccessSql, WRITE_ROLES } = require('./expertRAccess');
const { createArtifactVersionService } = require('./artifactVersions');
const { getExpertREnvironment } = require('./expertSandboxClient');
const { validateEnvironmentManifest, summarizeEnvironmentManifest, validateEnvironmentReference, assertEnvironmentMatches } = require('./rEnvironment');
const { createPrivateKernelClient } = require('./privateKernelClient');
const c = require('./privateKernelContract');
const { createPrivateKernelPublicationService } = require('./privateKernelPublications');
const { createPrivateKernelControlService } = require('./privateKernelControls');
const { createPrivateKernelSubmissionService } = require('./privateKernelSubmissions');
const { effectivePrivateRArtifactPolicy } = require('./privateRArtifactPolicy');
const { privateKernelTarget, validatePrivateKernelTarget } = require('./executionTargets');
const ACTIVE = ['starting','ready','running','unknown','stopping'];
const id = prefix => prefix + '_' + crypto.randomBytes(12).toString('hex');
const time = value => value == null ? null : new Date(value).toISOString();
const missing = () => c.kernelError('PRIVATE_KERNEL_NOT_FOUND', 'Private R session not found.', 404);
const formats = { 'org.r-project.rds':'rds', 'org.traceomics.seurat-checkpoint':'rds', 'org.ietf.csv':'csv', 'org.iana.tsv':'tsv', 'org.ietf.json':'json', 'org.ietf.text':'txt', 'org.w3.png':'png' };
function createPrivateKernelService(db, provider = storage.createLocalStorageProvider(), options = {}) {
  const client = options.client || createPrivateKernelClient();
  const getEnvironment = options.getEnvironment || getExpertREnvironment;
  const artifacts = createArtifactVersionService(db, provider);
  const now = options.now || Date.now;
  const probe = options.probeCapabilities || require('./expertRAccess').probeExpertRRuntime;
  const maxOwner = options.maxOwner || 1; const maxActive = options.maxActive || 2;
  async function transaction(callback) {
    const connection = await (await db.connect()).connect();
    try { await connection.query('BEGIN'); const value = await callback(connection); await connection.query('COMMIT'); return value; }
    catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
  }
  async function access(userId, projectId) {
    await db.requireProjectRole(userId, projectId, WRITE_ROLES);
    if (!expertRSandboxEnabled() || config.demoMode()) throw c.kernelError('PRIVATE_KERNEL_UNAVAILABLE', 'Private R sessions are unavailable in this deployment.', 503);
    if (!await db.hasExpertRExecuteCapability(userId, projectId)) throw c.kernelError('EXPERT_R_ACCESS_REQUIRED', 'Your account requires private R execution access.', 403);
  }
  async function lockedAccess(connection, userId, projectId) {
    await connection.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const membership = (await connection.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE', [projectId,userId])).rows[0];
    if (!membership) throw missing();
    if (!WRITE_ROLES.includes(membership.role) || !(await connection.query(`SELECT ${expertRAccessSql('$1','$2')} AS allowed`, [userId,projectId])).rows[0]?.allowed) throw c.kernelError('EXPERT_R_ACCESS_REQUIRED', 'Your current project role and private R access must allow execution.', 403);
  }
  async function owned(userId, projectId, kernelId) {
    if (!c.KERNEL_ID.test(kernelId || '')) throw missing();
    const row = (await db.query('SELECT * FROM private_r_kernels WHERE id=$1 AND project_id=$2 AND owner_user_id=$3',[kernelId,projectId,userId])).rows[0];
    if (!row) throw missing();
    row.restart_receipt=(await db.query('SELECT request_id,status,replacement_kernel_id FROM private_r_kernel_restarts WHERE kernel_id=$1',[kernelId])).rows[0]||null;
    return row;
  }
  function session(row) {
    row = { ...row, target_json: row.target_json?.id ? validatePrivateKernelTarget(row.target_json) : {} };
    return { id:row.id,projectId:row.project_id,workspaceId:row.workspace_id,analysisObjectId:row.analysis_object_id,status:row.status,generation:row.runtime_generation,restartedFromKernelId:row.restarted_from_kernel_id||null,restart:row.restart_receipt?{requestId:row.restart_receipt.request_id,status:row.restart_receipt.status,replacementKernelId:row.restart_receipt.replacement_kernel_id}:null,environment:row.environment_json,inputs:row.inputs_json,resources:row.resources_json,target:row.target_json,nextOrder:Number(row.next_order),activeExecutionId:row.active_execution_id,createdAt:time(row.created_at),startedAt:time(row.started_at),expiresAt:time(row.expires_at),stoppedAt:time(row.stopped_at),memoryState:['ready','running'].includes(row.status)?'available':['stopped','failed'].includes(row.status)?'lost':'unknown',replay:{complete:false,issues:['Variables and files in kernel memory are unsaved. Selected input versions and ordered source alone do not capture every intermediate value.','Console previews are journal evidence. Explicitly saved outputs retain artifact versions; other variables and files remain unsaved.']}};
  }
  function receipt(row, detail = false) {
    return { id:row.id,requestId:row.request_id,kernelId:row.kernel_id,generation:row.kernel_generation,order:Number(row.execution_order),status:row.status,sourceSha256:row.source_sha256,createdAt:time(row.created_at),startedAt:time(row.started_at),completedAt:time(row.completed_at),...(row.status==='failed'&&row.result_json?.interrupted===true&&row.result_json.error?.code==='PRIVATE_KERNEL_INTERRUPTED'?{interrupted:true}:{}),...(detail?{source:row.source_code,result:row.result_json}:{}),completionKnown:['completed','failed'].includes(row.status) };
  }
  async function stopRow(row) {
    if (!ACTIVE.includes(row.status)) return row;
    const claimed=(await db.query("UPDATE private_r_kernels SET status='stopping',updated_at=NOW() WHERE id=$1 AND status=ANY($2::text[]) RETURNING *",[row.id,ACTIVE])).rows[0];
    if(!claimed)return owned(row.owner_user_id,row.project_id,row.id);
    row=claimed;
    let stopped = false;
    try { const response = await client.stop(c.scope(row),row.id); stopped = response?.ok === true && response.kernelId === row.id && response.status === 'stopped' && (!row.runtime_generation || response.generation === row.runtime_generation); } catch { /* An unconfirmed stop must not imply recovered memory. */ }
    await transaction(async connection => {
      await connection.query("UPDATE private_r_executions SET status='unknown',updated_at=NOW() WHERE kernel_id=$1 AND status IN ('reserved','running')",[row.id]);
      await connection.query(`UPDATE private_r_kernels SET status=$2,active_execution_id=NULL,active_control_id=NULL,stopped_at=CASE WHEN $2='stopped' THEN NOW() ELSE stopped_at END,updated_at=NOW() WHERE id=$1 AND status=ANY($3::text[])`,[row.id,stopped?'stopped':'unknown',ACTIVE]);
    });
    if(stopped)await publications.afterStop(row);
    return owned(row.owner_user_id,row.project_id,row.id);
  }
  async function checked(row) {
    try { await access(row.owner_user_id,row.project_id); } catch (error) { if (ACTIVE.includes(row.status)) await stopRow(row); throw error; }
  }
  async function finalize(row, execution, result) {
    await transaction(async connection => {
      const current = (await connection.query('SELECT * FROM private_r_executions WHERE id=$1 FOR UPDATE',[execution.id])).rows[0];
      if (!current) return;
      if(['completed','failed'].includes(current.status)) {
        if(['completed','failed'].includes(result.status))await connection.query("UPDATE private_r_kernels SET status=CASE WHEN status IN ('stopping','stopped','failed') THEN status ELSE 'ready' END,active_execution_id=NULL,updated_at=NOW() WHERE id=$1 AND runtime_generation=$3 AND next_order=$4 AND (active_execution_id=$2 OR active_execution_id IS NULL)",[row.id,execution.id,row.runtime_generation,Number(execution.execution_order)]);
        return;
      }
      const terminal = ['completed','failed'].includes(result.status);
      await connection.query('UPDATE private_r_executions SET status=$2,result_json=$3,started_at=COALESCE($4,started_at),completed_at=$5,updated_at=NOW() WHERE id=$1',[execution.id,terminal?result.status:result.status==='executing'?'running':'unknown',terminal?result:null,result.startedAt||null,result.completedAt||null]);
      await connection.query(`UPDATE private_r_kernels SET status=CASE WHEN status IN ('stopping','stopped','failed') THEN status ELSE $2 END,active_execution_id=CASE WHEN status IN ('stopping','stopped','failed') OR $3 THEN NULL ELSE active_execution_id END,last_activity_at=NOW(),updated_at=NOW() WHERE id=$1 AND runtime_generation=$4`,[row.id,terminal?'ready':result.status==='executing'?'running':'unknown',terminal,row.runtime_generation]);
    });
  }
  async function reconcile(row) {
    if (!ACTIVE.includes(row.status)) return row;
    if(row.status==='starting'&&row.restarted_from_kernel_id) {
      const pending=(await db.query("SELECT updated_at FROM private_r_kernel_restarts WHERE replacement_kernel_id=$1 AND status='starting'",[row.id])).rows[0];
      if(pending&&now()-Date.parse(pending.updated_at)<150000)return row;
    }
    if (Date.parse(row.expires_at)<=now()) return stopRow(row);
    const publishing = await publications.reconcileActive(row);
    if (publishing) return publishing;
    try {
      const observed = c.state(await client.inspect(c.scope(row),row.id),row);
      if(row.active_control_id&&observed.status==='ready') {
        const latest=observed.lastExecution?.result||observed.lastExecution;
        const entry=latest?.executionId?(await db.query('SELECT * FROM private_r_executions WHERE id=$1 AND kernel_id=$2 AND owner_user_id=$3',[latest.executionId,row.id,row.owner_user_id])).rows[0]:null;
        if(entry&&Number(entry.execution_order)===Number(row.next_order)) {
          const confirmed=c.result(latest,row,entry);
          if(['completed','failed'].includes(confirmed.status)) {
            await finalize(row,entry,confirmed);
            await db.query('UPDATE private_r_kernels SET active_control_id=NULL,updated_at=NOW() WHERE id=$1 AND active_control_id=$2 AND runtime_generation=$3 AND next_order=$4',[row.id,row.active_control_id,row.runtime_generation,Number(row.next_order)]);
          }
        }
      }
      if (row.active_execution_id) {
        const execution = (await db.query('SELECT * FROM private_r_executions WHERE id=$1 AND kernel_id=$2',[row.active_execution_id,row.id])).rows[0];
        const latest=observed.lastExecution?.result || observed.lastExecution;
        if (execution && latest?.executionId === execution.id && latest.stdout !== undefined && ['ready','stopped'].includes(observed.status)) await finalize(row,execution,c.result(latest,row,execution));
        else if (execution && !['completed','failed'].includes(execution.status) && observed.status!=='executing' && observed.status!=='starting') await finalize(row,execution,{status:'unknown'});
      }
      const status = {ready:'ready',executing:'running',starting:'starting',unknown:'unknown',stopped:'stopped'}[observed.status];
      if (!row.target_json?.id) observed.target = await privateKernelTarget(db, observed.target);
      await db.query(`UPDATE private_r_kernels SET runtime_generation=COALESCE(runtime_generation,$2),resources_json=CASE WHEN resources_json='{}'::jsonb THEN $3 ELSE resources_json END,target_json=CASE WHEN target_json='{}'::jsonb THEN $4 ELSE target_json END,started_at=COALESCE(started_at,$5),expires_at=CASE WHEN resources_json='{}'::jsonb THEN $6 ELSE expires_at END,status=CASE WHEN status IN ('stopping','stopped','failed') THEN status WHEN status='unknown' AND next_order>0 AND $7='ready' THEN 'unknown' ELSE $7 END,stopped_at=CASE WHEN $7='stopped' THEN COALESCE(stopped_at,NOW()) ELSE stopped_at END,updated_at=NOW() WHERE id=$1 AND next_order=$8 AND (active_execution_id IS NOT DISTINCT FROM $9 OR active_execution_id IS NULL)`,[row.id,observed.generation,observed.resources,observed.target,observed.startedAt,observed.expiresAt,status,Number(row.next_order),row.active_execution_id]);
    } catch (error) {
      if (error.code==='PRIVATE_KERNEL_NOT_FOUND') await stopRow(row);
      else await db.query("UPDATE private_r_kernels SET status='unknown',updated_at=NOW() WHERE id=$1 AND status NOT IN ('stopped','failed')",[row.id]);
    }
    return owned(row.owner_user_id,row.project_id,row.id);
  }
  async function get(userId,projectId,kernelId) { let row=await owned(userId,projectId,kernelId); await checked(row); row=await reconcile(row); await checked(row); return session(row); }
  async function list(userId,projectId,options={}) {
    try { await access(userId,projectId); } catch(error) { const rows=(await db.query('SELECT * FROM private_r_kernels WHERE project_id=$1 AND owner_user_id=$2 AND status=ANY($3::text[]) LIMIT 4',[projectId,userId,ACTIVE])).rows; for(const row of rows) await stopRow(row); throw error; }
    const limit=Number(options.limit??10); if(!Number.isSafeInteger(limit)||limit<1||limit>10||options.workspaceId!==undefined&&!/^[A-Za-z0-9_-]{1,120}$/.test(options.workspaceId)) throw c.kernelError('PRIVATE_KERNEL_PAGE_INVALID','Select 1–10 sessions and a valid workspace.');
    const rows=(await db.query(`SELECT * FROM private_r_kernels WHERE project_id=$1 AND owner_user_id=$2${options.workspaceId?' AND workspace_id=$4':''} ORDER BY created_at DESC,id DESC LIMIT $3`,[projectId,userId,limit,...(options.workspaceId?[options.workspaceId]:[])])).rows;
    const items=[]; for(const row of rows) {const current=await reconcile(row);if(!current.restart_receipt)current.restart_receipt=(await db.query('SELECT request_id,status,replacement_kernel_id FROM private_r_kernel_restarts WHERE kernel_id=$1',[row.id])).rows[0]||null;items.push(session(current));} await access(userId,projectId); return {items};
  }
  function startInput(input) {
    if(!input||Object.keys(input).some(key=>!['requestId','workspaceId','analysisObjectId','environment','inputs'].includes(key))||!c.UUID.test(input.requestId||'')||!/^[A-Za-z0-9_-]{1,120}$/.test(input.workspaceId||'')||input.analysisObjectId!=null&&(!/^[A-Za-z0-9_-]{1,120}$/.test(input.analysisObjectId))||!Array.isArray(input.inputs)||input.inputs.length>c.LIMITS.inputs) throw c.kernelError('PRIVATE_KERNEL_REQUEST_INVALID','Select a workspace, exact environment, and at most five input versions.');
    const environment=validateEnvironmentReference(input.environment);
    const inputs=input.inputs.map(reference=>{if(!reference||typeof reference!=='object'||Array.isArray(reference))throw c.kernelError('PRIVATE_KERNEL_INPUT_INVALID','Select exact saved input versions.');return {artifactId:reference.artifactId,versionId:reference.versionId,projectId:reference.projectId,sha256:reference.sha256};});
    if(new Set(inputs.map(reference=>reference.versionId)).size!==inputs.length) throw c.kernelError('PRIVATE_KERNEL_INPUT_INVALID','Select each input version only once.');
    return {requestId:input.requestId,workspaceId:input.workspaceId,analysisObjectId:input.analysisObjectId||null,environment,inputs};
  }
  async function start(userId,projectId,raw) {
    await access(userId,projectId); const input=startInput(raw); const startHash=c.digest(input);
    let previous=(await db.query('SELECT * FROM private_r_kernels WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3',[projectId,userId,input.requestId])).rows[0];
    if(previous) { if(previous.start_sha256!==startHash) throw c.kernelError('PRIVATE_KERNEL_REQUEST_CONFLICT','This start request already refers to different session settings.',409); return get(userId,projectId,previous.id); }
    const manifest=validateEnvironmentManifest(await getEnvironment()); const environment=summarizeEnvironmentManifest(manifest); assertEnvironmentMatches(input.environment,environment);
    const selections=[...input.inputs];
    if(input.analysisObjectId) { const checkpoint=await db.getLoadableCheckpointForAnalysisObject(projectId,input.analysisObjectId,userId); selections.unshift({artifactId:checkpoint.checkpointArtifactId,versionId:checkpoint.checkpointArtifactId,projectId:String(projectId),sha256:checkpoint.checksumSha256}); }
    const verified=[]; let total=0; const artifactPolicy=selections.length?effectivePrivateRArtifactPolicy(await probe()):null;
    if(selections.length&&!artifactPolicy)throw c.kernelError('PRIVATE_KERNEL_UNAVAILABLE','The private R input policy could not be verified. Refresh server readiness before starting a session.',503);
    for(let index=0;index<selections.length;index++) {
      const opened=await artifacts.resolveVerified(userId,projectId,selections[index],{purpose:'execution'});
      try { const version=opened.version; total+=version.sizeBytes; if(version.sizeBytes>artifactPolicy.maxInputFileBytes||total>artifactPolicy.maxInputTotalBytes) throw c.kernelError('PRIVATE_KERNEL_INPUT_LIMIT','Selected private R inputs exceed the configured file or total session input size. Choose fewer inputs or ask the server administrator to adjust the private R limits.',413);
        verified.push({id:version.versionId,versionId:version.versionId,type:version.type,format:formats[version.format.id]||'bin',name:version.name,internalStorageKey:opened.internalStorageKey,checksumSha256:version.sha256,sizeBytes:version.sizeBytes,role:input.analysisObjectId&&index===0?'checkpoint':'input',reference:version.reference,publicFormat:version.format});
      } finally { await opened.handle.close(); }
    }
    const active=(await db.query('SELECT * FROM private_r_kernels WHERE status=ANY($2::text[]) AND (owner_user_id=$1 OR expires_at<=NOW()) LIMIT 40',[userId,ACTIVE])).rows;
    for(const row of active) await reconcile(row);
    const row=await transaction(async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(72419031)'); await lockedAccess(connection,userId,projectId);
      previous=(await connection.query('SELECT * FROM private_r_kernels WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3',[projectId,userId,input.requestId])).rows[0];
      if(previous) { if(previous.start_sha256!==startHash) throw c.kernelError('PRIVATE_KERNEL_REQUEST_CONFLICT','This start request already refers to different session settings.',409); return {...previous,repeated:true}; }
      const counts=(await connection.query('SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE owner_user_id=$1)::int AS owner FROM private_r_kernels WHERE status=ANY($2::text[])',[userId,ACTIVE])).rows[0];
      if(counts.total>=maxActive||counts.owner>=maxOwner) throw c.kernelError('PRIVATE_KERNEL_LIMIT','The active private R session limit is reached. Stop an unused session first.',429);
      if((await connection.query('SELECT id FROM private_r_kernels WHERE project_id=$1 AND owner_user_id=$2 AND workspace_id=$3 AND status=ANY($4::text[])',[projectId,userId,input.workspaceId,ACTIVE])).rows.length) throw c.kernelError('PRIVATE_KERNEL_WORKSPACE_BUSY','This workspace already has an active session. Inspect or stop it before starting another.',409);
      return (await connection.query(`INSERT INTO private_r_kernels(id,project_id,owner_user_id,workspace_id,analysis_object_id,request_id,start_sha256,status,environment_json,environment_manifest_json,inputs_json,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'starting',$8,$9,$10,$11) RETURNING *`,[id('pk'),projectId,userId,input.workspaceId,input.analysisObjectId,input.requestId,startHash,environment,manifest,JSON.stringify(verified.map(({internalStorageKey:_key,publicFormat,format:_format,...entry})=>({...entry,format:publicFormat}))),new Date(now()+14400000)])).rows[0];
    });
    if(row.repeated) return get(userId,projectId,row.id);
    try {
      await checked(row);
      const observed=c.state(await client.start({kernelId:row.id,...c.scope(row),environment,inputs:verified.map(({reference:_reference,publicFormat:_publicFormat,...entry})=>entry)}),row);
      observed.target = await privateKernelTarget(db, observed.target);
      await db.query("UPDATE private_r_kernels SET runtime_generation=$2,status=$3,resources_json=$4,target_json=$5,started_at=$6,expires_at=$7,last_activity_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='starting'",[row.id,observed.generation,observed.status==='ready'?'ready':'unknown',observed.resources,observed.target,observed.startedAt,observed.expiresAt]);
    } catch(error) { await db.query("UPDATE private_r_kernels SET status=$2,updated_at=NOW() WHERE id=$1 AND status='starting'",[row.id,['PRIVATE_KERNEL_UNAVAILABLE','PRIVATE_KERNEL_LIMIT','PRIVATE_KERNEL_ADMISSION_LIMIT','PRIVATE_KERNEL_INVALID','PRIVATE_KERNEL_INPUT_INVALID','PRIVATE_KERNEL_INPUT_INTEGRITY','PRIVATE_KERNEL_CONFLICT','PRIVATE_KERNEL_STOPPED','R_ENVIRONMENT_MISMATCH','ARTIFACT_INTEGRITY_FAILED'].includes(error.code)?'failed':'unknown']); throw error; }
    const current=await owned(userId,projectId,row.id); await checked(current); return session(current);
  }
  async function execution(userId,projectId,kernelId,executionId) {
    const row=await owned(userId,projectId,kernelId); await checked(row);
    if(!c.EXECUTION_ID.test(executionId||'')) throw missing();
    const entry=(await db.query('SELECT * FROM private_r_executions WHERE id=$1 AND kernel_id=$2 AND owner_user_id=$3',[executionId,kernelId,userId])).rows[0]; if(!entry) throw missing(); await checked(row); return receipt(entry,true);
  }
  async function executions(userId,projectId,kernelId,options={}) {
    const row=await owned(userId,projectId,kernelId); await checked(row); const limit=Number(options.limit??30); const before=options.before===undefined?501:Number(options.before);
    if(!Number.isSafeInteger(limit)||limit<1||limit>30||!Number.isSafeInteger(before)||before<1||before>501) throw c.kernelError('PRIVATE_KERNEL_PAGE_INVALID','Choose 1–30 journal entries and a valid command order.');
    const rows=(await db.query('SELECT * FROM private_r_executions WHERE kernel_id=$1 AND owner_user_id=$2 AND execution_order<$3 ORDER BY execution_order DESC LIMIT $4',[kernelId,userId,before,limit+1])).rows;
    await checked(row); return {items:rows.slice(0,limit).map(entry=>receipt(entry)),nextCursor:rows.length>limit?Number(rows[limit-1].execution_order):null};
  }
  async function execute(userId,projectId,kernelId,input) {
    let row=await owned(userId,projectId,kernelId); await checked(row);
    if(!input||Object.keys(input).some(key=>!['requestId','source'].includes(key))||!c.UUID.test(input.requestId||'')) throw c.kernelError('PRIVATE_KERNEL_REQUEST_INVALID','A valid command request identifier is required.');
    const code=c.source(input.source); const hash=c.digest(code);
    const reserved=await transaction(async connection=>{
      await lockedAccess(connection,userId,projectId); row=(await connection.query('SELECT * FROM private_r_kernels WHERE id=$1 FOR UPDATE',[kernelId])).rows[0];
      const prior=(await connection.query('SELECT * FROM private_r_executions WHERE kernel_id=$1 AND request_id=$2',[kernelId,input.requestId])).rows[0];
      if(prior) { if(prior.source_sha256!==hash) throw c.kernelError('PRIVATE_KERNEL_REQUEST_CONFLICT','This command request already refers to different R source.',409); return {entry:prior,repeated:true}; }
      if(row.status!=='ready'||row.active_execution_id||row.active_control_id||Date.parse(row.expires_at)<=now()) throw c.kernelError('PRIVATE_KERNEL_NOT_READY','The session is busy, expired, or its completion is unknown. Inspect its status before continuing.',409);
      if(Number(row.next_order)>=c.LIMITS.executions) throw c.kernelError('PRIVATE_KERNEL_JOURNAL_LIMIT','This session reached its retained-command limit. Start a new session.',409);
      const entry=(await connection.query(`INSERT INTO private_r_executions(id,kernel_id,project_id,owner_user_id,request_id,kernel_generation,execution_order,status,source_code,source_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9) RETURNING *`,[id('pex'),kernelId,projectId,userId,input.requestId,row.runtime_generation,Number(row.next_order)+1,code,hash])).rows[0];
      await connection.query("UPDATE private_r_kernels SET status='running',next_order=$2,active_execution_id=$3,last_activity_at=NOW(),updated_at=NOW() WHERE id=$1",[kernelId,entry.execution_order,entry.id]); return {entry};
    });
    if(reserved.repeated) return receipt(reserved.entry,true);
    const started=(await db.query("UPDATE private_r_executions e SET status='running',started_at=NOW(),updated_at=NOW() WHERE e.id=$1 AND e.status='reserved' AND EXISTS(SELECT 1 FROM private_r_kernels k WHERE k.id=e.kernel_id AND k.status='running' AND k.active_execution_id=e.id) RETURNING e.*",[reserved.entry.id])).rows[0];
    if(!started) return execution(userId,projectId,kernelId,reserved.entry.id);
    try { await checked(row); const output=c.result(await client.execute(c.scope(row),kernelId,{executionId:started.id,order:Number(started.execution_order),source:code}),row,started); await finalize(row,started,output); }
    catch(error) { await finalize(row,started,{status:'unknown'}); await checked(row); throw error; }
    await checked(await owned(userId,projectId,kernelId)); return execution(userId,projectId,kernelId,started.id);
  }
  async function stop(userId,projectId,kernelId) { const row=await owned(userId,projectId,kernelId); await checked(row); const result=await stopRow(row); await access(userId,projectId); return session(result); }
  const publications=createPrivateKernelPublicationService({db,provider,client,artifacts,transaction,access,lockedAccess,owned,checked,probe});
  const controls=createPrivateKernelControlService({db,client,artifacts,transaction,access,lockedAccess,owned,checked,stopRow,session,receipt,finalize,reconcile,publications,getEnvironment,now,maxOwner,maxActive,id,probe});
  const submissions=createPrivateKernelSubmissionService(db);
  async function submitted(kind,perform,userId,projectId,kernelId,input) {
    const result=await perform();
    return {...result,submission:await submissions.get(kind,userId,projectId,input.requestId,kernelId)};
  }
  return {list,get,execution,executions,stop,interrupt:controls.interrupt,restartStatus:controls.restartStatus,publications:publications.list,
    start:(userId,projectId,input)=>submitted('start',()=>start(userId,projectId,input),userId,projectId,null,input),
    execute:(userId,projectId,kernelId,input)=>submitted('execution',()=>execute(userId,projectId,kernelId,input),userId,projectId,kernelId,input),
    publish:(userId,projectId,kernelId,input)=>submitted('publication',()=>publications.publish(userId,projectId,kernelId,input),userId,projectId,kernelId,input),
    restart:(userId,projectId,kernelId,input)=>submitted('restart',()=>controls.restart(userId,projectId,kernelId,input),userId,projectId,kernelId,input),
    submission:submissions.get};
}
module.exports={createPrivateKernelService};
