'use strict';

const c = require('./privateKernelContract');
const {validateEnvironmentManifest,summarizeEnvironmentManifest,assertEnvironmentMatches} = require('./rEnvironment');
const {probeExpertRRuntime} = require('./expertRAccess');
const formats = {'org.r-project.rds':'rds','org.traceomics.seurat-checkpoint':'rds','org.ietf.csv':'csv','org.iana.tsv':'tsv','org.ietf.json':'json','org.ietf.text':'txt','org.w3.png':'png'};
const active = ['starting','ready','running','unknown','stopping'];
const failure = (code,message,status=409) => c.kernelError(code,message,status);
function controlInput(input,keys) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!keys.includes(key)) || !c.UUID.test(input.requestId||'') || !c.HASH.test(input.generation||'')) throw failure('PRIVATE_KERNEL_CONTROL_INVALID','Select the exact session generation and a valid control request identifier.',400);
}
function createPrivateKernelControlService({db,client,artifacts,transaction,access,lockedAccess,owned,checked,stopRow,session,receipt,finalize,reconcile,publications,getEnvironment,now,maxOwner,maxActive,id,probe=probeExpertRRuntime}) {
  async function checkedRestart(kernel) {
    try {await checked(kernel);}
    catch(error) {
      if(error.status===403||error.status===404) {
        // An old receipt belongs to one explicit replacement. Revocation of
        // this restart stops that exact creator-owned replacement only.
        const replacement=(await db.query(`SELECT child.* FROM private_r_kernel_restarts link
          JOIN private_r_kernels child ON child.id=link.replacement_kernel_id
          WHERE link.kernel_id=$1 AND link.project_id=$2 AND link.owner_user_id=$3
            AND child.project_id=$2 AND child.owner_user_id=$3 AND child.status=ANY($4::text[])`,[kernel.id,kernel.project_id,kernel.owner_user_id,active])).rows[0];
        if(replacement)await stopRow(replacement);
      }
      throw error;
    }
  }
  async function interrupt(userId,projectId,kernelId,input) {
    let kernel=await owned(userId,projectId,kernelId);await checked(kernel);
    controlInput(input,['requestId','generation','executionId','executionRequestId']);
    if(input.executionId!==undefined&&!c.EXECUTION_ID.test(input.executionId) || input.executionRequestId!==undefined&&!c.UUID.test(input.executionRequestId)) throw failure('PRIVATE_KERNEL_CONTROL_INVALID','Select the exact pending command to interrupt.',400);
    if(kernel.runtime_generation!==input.generation)throw failure('PRIVATE_KERNEL_INTERRUPT_INVALID','The interrupt request refers to a different session generation.');
    const capability=await probe();
    if(capability.state!=='ready'||capability.persistentKernelInterrupt!==true)throw failure('PRIVATE_KERNEL_INTERRUPT_UNAVAILABLE','Interruption is unavailable in this runtime. You can stop the session and explicitly start again.',503);
    const execution=await transaction(async connection=>{
      await lockedAccess(connection,userId,projectId);
      kernel=(await connection.query('SELECT * FROM private_r_kernels WHERE id=$1 FOR UPDATE',[kernelId])).rows[0];
      if(kernel.runtime_generation!==input.generation || !['ready','running','unknown'].includes(kernel.status))throw failure('PRIVATE_KERNEL_INTERRUPT_INVALID','The session ended or changed before interruption.');
      const target=input.executionId || kernel.active_execution_id;
      // Source/order/identity are immutable. Reading the receipt without an
      // execution lock avoids inversion with terminal finalization, which
      // holds the execution while updating the same kernel row.
      let entry=target?(await connection.query('SELECT * FROM private_r_executions WHERE id=$1 AND kernel_id=$2 AND owner_user_id=$3',[target,kernelId,userId])).rows[0]:null;
      if(!entry&&input.executionRequestId)entry=(await connection.query('SELECT * FROM private_r_executions WHERE kernel_id=$1 AND request_id=$2 AND owner_user_id=$3',[kernelId,input.executionRequestId,userId])).rows[0];
      if(!entry || entry.kernel_generation!==input.generation || Number(entry.execution_order)!==Number(kernel.next_order) || kernel.active_execution_id&&kernel.active_execution_id!==entry.id || input.executionId&&input.executionId!==entry.id || input.executionRequestId&&input.executionRequestId!==entry.request_id)throw failure('PRIVATE_KERNEL_INTERRUPT_INVALID','The interrupt request no longer matches the active command. Refresh the session before continuing.');
      if(kernel.active_control_id&&kernel.active_control_id!==input.requestId)throw failure('PRIVATE_KERNEL_CONTROL_BUSY','An interruption is already awaiting confirmation. Refresh the session before continuing.');
      await connection.query('UPDATE private_r_kernels SET active_control_id=$2,updated_at=NOW() WHERE id=$1',[kernelId,input.requestId]);
      return entry;
    });
    let observed;
    try {observed=c.interruptResult(await client.interrupt(c.scope(kernel),kernelId,{requestId:input.requestId,executionId:execution.id,order:Number(execution.execution_order)}),kernel,execution);}
    catch(error) {
      if(!['PRIVATE_KERNEL_INTERRUPT_UNAVAILABLE','PRIVATE_KERNEL_INTERRUPT_UNSUPPORTED','PRIVATE_KERNEL_INTERRUPT_INVALID','PRIVATE_KERNEL_CONTROL_INVALID'].includes(error.code))await db.query("UPDATE private_r_kernels SET status='unknown',updated_at=NOW() WHERE id=$1 AND active_control_id=$2 AND status NOT IN ('stopping','stopped','failed')",[kernelId,input.requestId]);
      await db.query('UPDATE private_r_kernels SET active_control_id=NULL,updated_at=NOW() WHERE id=$1 AND active_control_id=$2',[kernelId,input.requestId]);
      await checked(await owned(userId,projectId,kernelId));throw error;
    }
    // Publication reconciliation owns readiness until its exact file handoff or
    // failed-output cleanup is settled. Interruption never bypasses that fence.
    try {
      const publishing=await publications.reconcileActive(await owned(userId,projectId,kernelId));
      if(!publishing) {
        if(observed.idleConfirmed)await finalize(kernel,execution,observed.execution);
        else await transaction(async connection=>{
          await connection.query("UPDATE private_r_executions SET status='unknown',updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','failed')",[execution.id]);
          await connection.query("UPDATE private_r_kernels SET status='unknown',updated_at=NOW() WHERE id=$1 AND runtime_generation=$2 AND status NOT IN ('stopping','stopped','failed')",[kernelId,input.generation]);
        });
      }
    } catch(error) {
      await db.query("UPDATE private_r_kernels SET status='unknown',updated_at=NOW() WHERE id=$1 AND active_control_id=$2 AND status NOT IN ('stopping','stopped','failed')",[kernelId,input.requestId]);throw error;
    } finally {
      await db.query('UPDATE private_r_kernels SET active_control_id=NULL,updated_at=NOW() WHERE id=$1 AND active_control_id=$2',[kernelId,input.requestId]);
    }
    const current=await owned(userId,projectId,kernelId);await checked(current);
    const entry=(await db.query('SELECT * FROM private_r_executions WHERE id=$1',[execution.id])).rows[0];
    return {session:session(current),execution:receipt(entry,true),outcome:observed.outcome,idleConfirmed:observed.idleConfirmed&&current.status==='ready'};
  }
  async function restartRow(kernelId) {return (await db.query('SELECT * FROM private_r_kernel_restarts WHERE kernel_id=$1',[kernelId])).rows[0];}
  async function present(row,userId,projectId) {
    let replacement=(await db.query('SELECT * FROM private_r_kernels WHERE id=$1 AND owner_user_id=$2 AND project_id=$3',[row.replacement_kernel_id,userId,projectId])).rows[0];
    if(!replacement&&row.status==='unknown') {
      // A failed stop cannot authorize replacement dispatch. Once the exact
      // old generation is confirmed stopped, this abandoned request can end
      // honestly and a separate explicit Start may create another session.
      const recovered=(await db.query(`UPDATE private_r_kernel_restarts link
        SET status='failed',failure_code='PRIVATE_KERNEL_RESTART_NOT_STARTED',completed_at=NOW(),updated_at=NOW()
        WHERE link.id=$1 AND link.status='unknown'
          AND NOT EXISTS(SELECT 1 FROM private_r_kernels child WHERE child.id=link.replacement_kernel_id)
          AND EXISTS(SELECT 1 FROM private_r_kernels previous WHERE previous.id=link.kernel_id
            AND previous.project_id=link.project_id AND previous.owner_user_id=link.owner_user_id
            AND previous.runtime_generation=link.kernel_generation AND previous.status='stopped')
        RETURNING link.*`,[row.id])).rows[0];
      if(recovered)row=recovered;
    }
    if(replacement&&!['completed','failed'].includes(row.status) && !(replacement.status==='starting'&&row.status==='starting'&&now()-Date.parse(row.updated_at)<150000)) {
      replacement=await reconcile(replacement);
      if(replacement.status==='ready')await db.query("UPDATE private_r_kernel_restarts SET status='completed',completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','failed')",[row.id]);
      else if(['stopped','failed'].includes(replacement.status))await db.query("UPDATE private_r_kernel_restarts SET status='failed',failure_code='PRIVATE_KERNEL_RESTART_FAILED',completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','failed')",[row.id]);
      row=await restartRow(row.kernel_id);
    }
    await access(userId,projectId);
    const previous=await owned(userId,projectId,row.kernel_id);
    return {id:row.id,requestId:row.request_id,previousKernelId:row.kernel_id,replacementKernelId:row.replacement_kernel_id,status:row.status,...(row.failure_code?{failureCode:row.failure_code}:{}),session:replacement?session(replacement):null,previousSession:session(previous),replay:{performed:false,unsavedMemoryLost:['stopped','failed'].includes(previous.status)?true:null}};
  }
  async function verifiedSnapshot(userId,projectId,kernel) {
    const manifest=validateEnvironmentManifest(await getEnvironment());
    assertEnvironmentMatches(kernel.environment_json,summarizeEnvironmentManifest(manifest));
    const verified=[];let total=0;
    for(const selection of kernel.inputs_json) {
      const opened=await artifacts.resolveVerified(userId,projectId,selection.reference,{purpose:'execution'});
      try {
        const version=opened.version;total+=version.sizeBytes;
        if(version.versionId!==selection.versionId || version.sha256!==selection.checksumSha256 || version.sizeBytes!==Number(selection.sizeBytes))throw failure('PRIVATE_KERNEL_INPUT_INTEGRITY','An original input version changed. The session was not restarted.');
        if(version.sizeBytes>200*1024*1024 || total>c.LIMITS.inputBytes)throw failure('PRIVATE_KERNEL_INPUT_LIMIT','The original private R inputs exceed the bounded session input size.',413);
        verified.push({id:selection.id,versionId:version.versionId,type:version.type,format:formats[version.format.id]||'bin',name:version.name,internalStorageKey:opened.internalStorageKey,checksumSha256:version.sha256,sizeBytes:version.sizeBytes,role:selection.role});
      } finally {await opened.handle.close();}
    }
    return verified;
  }
  async function restart(userId,projectId,kernelId,input) {
    let kernel=await owned(userId,projectId,kernelId);await checkedRestart(kernel);
    controlInput(input,['requestId','generation']);
    if(kernel.runtime_generation!==input.generation)throw failure('PRIVATE_KERNEL_RESTART_CONFLICT','The restart request refers to a different session generation.');
    const hash=c.digest({requestId:input.requestId,generation:input.generation,kernelId});
    let previous=await restartRow(kernelId);
    if(previous){if(previous.request_sha256!==hash)throw failure('PRIVATE_KERNEL_REQUEST_CONFLICT','This session already has a different recorded restart. Inspect the linked replacement session.');return present(previous,userId,projectId);}
    // Verify the original exact snapshot before discarding working memory. A
    // restart never discovers a newer checkpoint or reruns scientific source.
    const verified=await verifiedSnapshot(userId,projectId,kernel);
    const reserved=await transaction(async connection=>{
      await lockedAccess(connection,userId,projectId);
      kernel=(await connection.query('SELECT * FROM private_r_kernels WHERE id=$1 FOR UPDATE',[kernelId])).rows[0];
      previous=(await connection.query('SELECT * FROM private_r_kernel_restarts WHERE kernel_id=$1',[kernelId])).rows[0];
      if(previous){if(previous.request_sha256!==hash)throw failure('PRIVATE_KERNEL_REQUEST_CONFLICT','This session already has a different recorded restart.');return {...previous,repeated:true};}
      if((await connection.query('SELECT id FROM private_r_kernels WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3 UNION ALL SELECT id FROM private_r_kernel_restarts WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3',[projectId,userId,input.requestId])).rows.length)throw failure('PRIVATE_KERNEL_REQUEST_CONFLICT','This request identifier already refers to another session or restart.');
      if(kernel.runtime_generation!==input.generation || kernel.status==='starting')throw failure('PRIVATE_KERNEL_RESTART_CONFLICT','The session generation is not confirmed for restart.');
      const row=(await connection.query(`INSERT INTO private_r_kernel_restarts(id,kernel_id,project_id,owner_user_id,request_id,request_sha256,kernel_generation,replacement_kernel_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'stopping') RETURNING *`,[id('prst'),kernelId,projectId,userId,input.requestId,hash,input.generation,id('pk')])).rows[0];
      if(kernel.status!=='stopped')await connection.query("UPDATE private_r_kernels SET status='stopping',updated_at=NOW() WHERE id=$1",[kernelId]);
      return row;
    });
    if(reserved.repeated)return present(reserved,userId,projectId);
    try {
      const beforeStop=await owned(userId,projectId,kernelId);
      if(beforeStop.status==='stopped') {
        const confirmed=await client.stop(c.scope(beforeStop),kernelId);
        if(confirmed?.ok!==true || confirmed.kernelId!==kernelId || confirmed.generation!==input.generation || confirmed.status!=='stopped')throw failure('PRIVATE_KERNEL_RESTART_UNKNOWN','The old runtime could not be confirmed stopped. No replacement session was started.',503);
        await publications.afterStop(beforeStop);
      }
      const stopped=beforeStop.status==='stopped'?beforeStop:await stopRow(beforeStop);
      if(stopped.status!=='stopped')throw failure('PRIVATE_KERNEL_RESTART_UNKNOWN','The old session could not be confirmed stopped. No replacement session was started.',503);
      // Recheck the original environment and exact input bytes after stopping,
      // including access revoked while the upstream stop response was pending.
      await access(userId,projectId);
      const freshVerified=await verifiedSnapshot(userId,projectId,kernel);
      if(c.digest(freshVerified)!==c.digest(verified))throw failure('PRIVATE_KERNEL_INPUT_INTEGRITY','An original input version changed before restart.');
      const replacement=await transaction(async connection=>{
        await connection.query('SELECT pg_advisory_xact_lock(72419031)');await lockedAccess(connection,userId,projectId);
        const link=(await connection.query('SELECT * FROM private_r_kernel_restarts WHERE id=$1 FOR UPDATE',[reserved.id])).rows[0];
        if(link.status!=='stopping')throw failure('PRIVATE_KERNEL_RESTART_UNKNOWN','This restart no longer has a confirmed dispatch reservation.',503);
        const old=(await connection.query('SELECT * FROM private_r_kernels WHERE id=$1 FOR UPDATE',[kernelId])).rows[0];
        if(old.status!=='stopped'||old.runtime_generation!==input.generation)throw failure('PRIVATE_KERNEL_RESTART_UNKNOWN','The old session is not confirmed stopped.',503);
        const counts=(await connection.query('SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE owner_user_id=$1)::int AS owner FROM private_r_kernels WHERE status=ANY($2::text[])',[userId,active])).rows[0];
        if(counts.total>=maxActive||counts.owner>=maxOwner)throw failure('PRIVATE_KERNEL_LIMIT','The active private R session limit is reached. The old session is stopped.',429);
        const created=(await connection.query(`INSERT INTO private_r_kernels(id,project_id,owner_user_id,workspace_id,analysis_object_id,request_id,start_sha256,status,environment_json,environment_manifest_json,inputs_json,expires_at,restarted_from_kernel_id) VALUES($1,$2,$3,$4,$5,$6,$7,'starting',$8,$9,$10,$11,$12) RETURNING *`,[reserved.replacement_kernel_id,projectId,userId,kernel.workspace_id,kernel.analysis_object_id,input.requestId,hash,kernel.environment_json,kernel.environment_manifest_json,JSON.stringify(kernel.inputs_json),new Date(now()+14400000),kernelId])).rows[0];
        await connection.query("UPDATE private_r_kernel_restarts SET status='starting',updated_at=NOW() WHERE id=$1",[reserved.id]);return created;
      });
      await checked(replacement);
      const observed=c.state(await client.start({kernelId:replacement.id,...c.scope(replacement),environment:replacement.environment_json,inputs:freshVerified}),replacement);
      await db.query("UPDATE private_r_kernels SET runtime_generation=$2,status=$3,resources_json=$4,target_json=$5,started_at=$6,expires_at=$7,last_activity_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='starting'",[replacement.id,observed.generation,observed.status==='ready'?'ready':'unknown',observed.resources,observed.target,observed.startedAt,observed.expiresAt]);
      await checked(await owned(userId,projectId,replacement.id));
    } catch(error) {
      const uncertain=['PRIVATE_KERNEL_TRANSPORT_UNKNOWN','PRIVATE_KERNEL_RESPONSE_INVALID','PRIVATE_KERNEL_RESTART_UNKNOWN'].includes(error.code);
      await db.query("UPDATE private_r_kernels SET status=$2,updated_at=NOW() WHERE id=$1 AND status='starting'",[reserved.replacement_kernel_id,uncertain?'unknown':'failed']);
      await db.query("UPDATE private_r_kernel_restarts SET status=$2,failure_code=$3,completed_at=CASE WHEN $2='failed' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','failed')",[reserved.id,uncertain?'unknown':'failed',/^[A-Z0-9_]{1,80}$/.test(error.code||'')?error.code:'PRIVATE_KERNEL_RESTART_FAILED']);
      if(error.status===403||error.status===404)throw error;
      // Once the destructive phase was reserved, return its recorded outcome
      // so the caller sees that old memory ended even if admission failed.
    }
    return present(await restartRow(kernelId),userId,projectId);
  }
  async function restartStatus(userId,projectId,kernelId) {
    const kernel=await owned(userId,projectId,kernelId);await checkedRestart(kernel);
    const row=await restartRow(kernelId);if(!row)throw failure('PRIVATE_KERNEL_RESTART_NOT_FOUND','No recorded restart exists for this session.',404);
    return present(row,userId,projectId);
  }
  return {interrupt,restart,restartStatus};
}
module.exports={createPrivateKernelControlService};
