'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const storage = require('./storage');
const c = require('./privateKernelContract');
const {generatePrivateKernelExportSource} = require('./privateKernelExports');
const {effectivePrivateRArtifactPolicy,validatePrivateRArtifactPolicy} = require('./privateRArtifactPolicy');
const LEGACY_PUBLICATION_BYTES = 20 * 1024 * 1024;
const specs = {object:{type:'object',formatId:'org.r-project.rds',extension:'rds',mime:'application/octet-stream'},table:{type:'table',formatId:'org.ietf.csv',extension:'csv',mime:'text/csv'},figure:{type:'image',formatId:'org.w3.png',extension:'png',mime:'image/png'}};
const id = prefix => prefix+'_'+crypto.randomBytes(12).toString('hex');
const time = value => value ? new Date(value).toISOString() : null;
const error = (code,message,status=400) => c.kernelError(code,message,status);
const denied = failure => failure.status===403||failure.status===404||['NOT_FOUND','FORBIDDEN','PROJECT_ROLE_REQUIRED','EXPERT_R_ACCESS_REQUIRED'].includes(failure.code);
function input(raw) {
  if (!raw || Object.keys(raw).some(key=>!['requestId','name','type','binding','executionId','figureIndex','previousVersionId'].includes(key)) || !c.UUID.test(raw.requestId||'') || !Object.hasOwn(specs,raw.type) || typeof raw.name!=='string' || !raw.name.trim() || raw.name.trim().length>160 || /[\p{Cc}]/u.test(raw.name)) throw error('PRIVATE_KERNEL_PUBLICATION_INVALID','Choose a save type and a name of 1–160 characters on one line.');
  if (raw.previousVersionId!=null && !/^av_[a-f0-9]{24}$/.test(raw.previousVersionId)) throw error('PRIVATE_KERNEL_PUBLICATION_INVALID','Select an exact managed version to replace.');
  if (raw.type==='figure') {
    if(raw.binding!==undefined || !c.EXECUTION_ID.test(raw.executionId||'') || !Number.isSafeInteger(raw.figureIndex) || raw.figureIndex<0 || raw.figureIndex>=c.LIMITS.figures) throw error('PRIVATE_KERNEL_PUBLICATION_INVALID','Select a figure from an exact completed console command.');
  } else if (raw.executionId!==undefined || raw.figureIndex!==undefined || typeof raw.binding!=='string' || !raw.binding || Buffer.byteLength(raw.binding)>256 || /[\p{Cc}]/u.test(raw.binding)) throw error('PRIVATE_KERNEL_PUBLICATION_INVALID','Enter the exact name of an existing global R binding, using at most 256 UTF-8 bytes.');
  return {requestId:raw.requestId,name:raw.name.trim(),type:raw.type,...(raw.type==='figure'?{executionId:raw.executionId,figureIndex:raw.figureIndex}:{binding:raw.binding}),previousVersionId:raw.previousVersionId||null};
}
function createPrivateKernelPublicationService({db,provider,client,artifacts,transaction,access,lockedAccess,owned,checked,probe}) {
  async function readAccess(userId,projectId,kernelId) {await db.requireProjectRole(userId,projectId,['owner','admin','analyst','viewer']);return owned(userId,projectId,kernelId);}
  async function rowById(publicationId) {return (await db.query('SELECT * FROM private_r_publications WHERE id=$1',[publicationId])).rows[0];}
  function receipt(row) {
    return {id:row.id,requestId:row.request_id,requestHash:row.request_sha256,status:row.status,type:row.publication_type,name:row.name,maximumBytes:Number(row.reserved_bytes),kernelId:row.kernel_id,generation:row.kernel_generation,sourceExecutionId:row.source_execution_id,order:Number(row.kernel_order),sourceSha256:row.lineage_json.sourceSha256,createdAt:time(row.created_at),completedAt:time(row.completed_at),lineage:row.lineage_json,...(row.status==='unknown'?{message:'Save completion is unconfirmed. Refresh this receipt; its serialization command will not run again.'}:row.status==='failed'?{message:'This save did not produce a verified artifact version within its reserved capacity. Earlier saved versions and its source and execution receipt remain available.'}:{})};
  }
  async function present(row) {return {publication:receipt(row),version:row.status==='completed'?await artifacts.get(row.owner_user_id,row.project_id,row.version_id):null};}
  async function lineage(connection,kernel,execution) {
    const sources=(await connection.query('SELECT id,execution_order,source_sha256,status FROM private_r_executions WHERE kernel_id=$1 AND execution_order<$2 ORDER BY execution_order',[kernel.id,execution.execution_order])).rows;
    return {schemaVersion:1,kind:'private-r-publication',kernelId:kernel.id,generation:kernel.runtime_generation,sourceExecutionId:execution.id,order:Number(execution.execution_order),sourceSha256:execution.source_sha256,environment:kernel.environment_json,inputs:kernel.inputs_json,resources:kernel.resources_json,target:kernel.target_json,sourceVersions:sources.map(row=>({id:row.id,order:Number(row.execution_order),sha256:row.source_sha256,status:row.status})),replay:{complete:false,issues:['The ordered source and selected exact inputs are retained, but unsaved intermediate R variables and files are not captured.','External influences, nondeterministic operations, and undeclared dependencies may prevent exact replay.']}};
  }
  async function commandOutcome(connection,kernel,pub,result,status) {
    if (pub.publication_type==='figure') return;
    await connection.query(`UPDATE private_r_executions SET status=$2,result_json=$3,started_at=COALESCE($4,started_at),completed_at=$5,updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','failed')`,[pub.source_execution_id,result?.status==='completed'?'completed':result?.status==='failed'?'failed':status==='completed'?'completed':status==='failed'?'unknown':status==='running'?'running':'unknown',result||null,result?.startedAt||null,result?.completedAt||null]);
    const consumedOrder=['completed','failed'].includes(result?.status)||status==='completed';
    const finished=consumedOrder&&['completed','failed'].includes(status);
    await connection.query(`UPDATE private_r_kernels SET status=CASE WHEN status IN ('stopped','stopping','failed') THEN status ELSE $3 END,active_execution_id=CASE WHEN $4 THEN NULL ELSE active_execution_id END,last_activity_at=NOW(),updated_at=NOW() WHERE id=$1 AND active_execution_id=$2 AND runtime_generation=$5`,[kernel.id,pub.source_execution_id,finished?'ready':status==='running'?'running':'unknown',finished,pub.kernel_generation]);
  }
  async function fail(pub,kernel,result=null) {
    await transaction(async connection=>{
      const current=(await connection.query('SELECT * FROM private_r_publications WHERE id=$1 FOR UPDATE',[pub.id])).rows[0];if(!current||current.status==='completed')return;
      if(current.status==='failed'){if(result)await commandOutcome(connection,kernel,current,result,'failed');return;}
      // Hold the reservation while removing its exact owned key. A concurrent
      // successful commit cannot race cleanup, and failed unlink keeps quota.
      let removed=false;try{await provider.remove(current.storage_key);removed=true;}catch{/* Completion/cleanup remains unconfirmed and accounted. */}
      await commandOutcome(connection,kernel,current,result,removed?'failed':'unknown');
      await connection.query("UPDATE private_r_publications SET status=$2,completed_at=CASE WHEN $2='failed' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$1",[pub.id,removed?'failed':'unknown']);
    });
  }
  async function applyExport(pub,kernel,raw) {
    const execution=(await db.query('SELECT * FROM private_r_executions WHERE id=$1',[pub.source_execution_id])).rows[0];
    const observed=c.publicationResult(raw,kernel,pub,execution);
    if (!['completed','failed'].includes(observed.status)) {
      await transaction(async connection=>{
        const current=(await connection.query('SELECT * FROM private_r_publications WHERE id=$1 FOR UPDATE',[pub.id])).rows[0];if(['completed','failed'].includes(current.status))return;
        await commandOutcome(connection,kernel,current,null,observed.status==='executing'?'running':'unknown');await connection.query('UPDATE private_r_publications SET status=$2,updated_at=NOW() WHERE id=$1',[pub.id,observed.status==='executing'?'running':'unknown']);
      });return;
    }
    if(observed.status==='failed'){await fail(pub,kernel,observed.result);return;}
    let opened;
    try {
      opened=await provider.openVerifiedRead(pub.storage_key,{checksumSha256:observed.file.checksumSha256,sizeBytes:observed.file.sizeBytes});
      await commit(pub,kernel,observed.file,observed.result);
    } catch(failure) {
      await fail(pub,kernel,observed.result);
      if(denied(failure))await checked(await owned(pub.owner_user_id,pub.project_id,kernel.id));
      if(['STORAGE_CHECKSUM_MISMATCH','STORAGE_SIZE_MISMATCH','STORAGE_OBJECT_MISSING','UNSAFE_STORAGE_PATH'].includes(failure.code))throw error('PRIVATE_KERNEL_PUBLICATION_INTEGRITY','The saved output is missing or failed its integrity check. No artifact version was published.',409);
      throw failure;
    } finally {if(opened)await opened.handle.close();}
  }
  async function commit(pub,kernel,file,result=null,figure=null,existingConnection=null) {
    await access(pub.owner_user_id,pub.project_id);
    const perform=async connection=>{
      await lockedAccess(connection,pub.owner_user_id,pub.project_id);
      await connection.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[pub.project_id]);
      const current=(await connection.query('SELECT * FROM private_r_publications WHERE id=$1 FOR UPDATE',[pub.id])).rows[0];
      if(current.status==='completed')return;if(current.status==='failed')throw error('PRIVATE_KERNEL_PUBLICATION_CONFLICT','This save already ended without publication.',409);
      if(pub.publication_type!=='figure') {
        await connection.query('SELECT id FROM private_r_executions WHERE id=$1 FOR UPDATE',[pub.source_execution_id]);
        const active=(await connection.query('SELECT * FROM private_r_kernels WHERE id=$1 FOR UPDATE',[kernel.id])).rows[0];
        if(!active || active.runtime_generation!==pub.kernel_generation || Number(active.next_order)!==Number(pub.kernel_order) || !['running','unknown'].includes(active.status) || active.active_execution_id!==pub.source_execution_id) throw error('PRIVATE_KERNEL_PUBLICATION_CONFLICT','The session ended or changed before this save was verified. No artifact version was published.',409);
      }
      const spec=specs[pub.publication_type]; const metadata=figure?{'org.traceomics.image:width':figure.width,'org.traceomics.image:height':figure.height}:pub.publication_type==='table'?{'org.traceomics.preview:validation':'private-r-serializer'}:{};
      await artifacts.registerProduced(connection,pub.owner_user_id,pub.project_id,{versionId:pub.version_id,artifactId:pub.artifact_id,previousVersionId:pub.previous_version_id,type:spec.type,format:{id:spec.formatId,version:'1',...(Object.keys(metadata).length?{metadata}:{})},name:pub.name,mimeType:spec.mime,key:pub.storage_key,sizeBytes:file.sizeBytes,checksumSha256:file.checksumSha256,publicationId:pub.id,provenance:{...pub.lineage_json,publicationId:pub.id}});
      await commandOutcome(connection,kernel,pub,result,'completed');
      await connection.query("UPDATE private_r_publications SET status='completed',checksum_sha256=$2,size_bytes=$3,completed_at=NOW(),updated_at=NOW() WHERE id=$1",[pub.id,file.checksumSha256,file.sizeBytes]);
    };
    if(existingConnection)await perform(existingConnection);else await transaction(perform);
  }
  async function recover(pub,kernel) {
    if(['completed','failed'].includes(pub.status))return;
    if(pub.publication_type==='figure'){
      let opened;
      try{
        const execution=(await db.query("SELECT * FROM private_r_executions WHERE id=$1 AND kernel_id=$2 AND project_id=$3 AND owner_user_id=$4 AND status='completed'",[pub.source_execution_id,kernel.id,pub.project_id,pub.owner_user_id])).rows[0];
        if(!execution||execution.kernel_generation!==pub.kernel_generation||!execution.result_json)throw error('PRIVATE_KERNEL_PUBLICATION_INVALID','The retained source figure is unavailable.');
        c.publicationSource(kernel,pub,execution);
        const figure=c.result(execution.result_json,kernel,execution).figures[pub.figure_index];if(!figure)throw error('PRIVATE_KERNEL_PUBLICATION_INVALID','The retained source figure is unavailable.');
        const expected={checksumSha256:figure.sha256,sizeBytes:Buffer.from(figure.data,'base64').length};
        opened=await provider.openVerifiedRead(pub.storage_key,expected);
        await commit(pub,kernel,expected,null,figure);
      }catch{await fail(pub,kernel);}finally{if(opened)await opened.handle.close();}
      return;
    }
    if(kernel.status==='stopped'){
      // Confirm runtime cleanup even after a database restore before removing
      // a reserved key. This does not infer scientific completion from bytes.
      try{const stopped=await client.stop(c.scope(kernel),kernel.id);if(stopped?.ok===true&&stopped.kernelId===kernel.id&&stopped.status==='stopped'&&stopped.generation===pub.kernel_generation)await fail(pub,kernel);}catch{/* Retain quota while runtime cleanup cannot be confirmed. */}
      return;
    }
    // A receipt refresh may inspect a remembered export, never dispatch source.
    let raw;
    try {await access(pub.owner_user_id,pub.project_id);raw=await client.exportStatus(c.scope(kernel),kernel.id,{publicationId:pub.id});}
    catch(failure){if(!['PRIVATE_KERNEL_PUBLICATION_NOT_FOUND','PRIVATE_KERNEL_TRANSPORT_UNKNOWN'].includes(failure.code)&&!denied(failure))throw failure;return;}
    await applyExport(pub,kernel,raw);
  }
  async function reconcileActive(kernel) {
    if(!kernel.active_execution_id)return null;
    const pub=(await db.query("SELECT * FROM private_r_publications WHERE kernel_id=$1 AND source_execution_id=$2 AND publication_type<>'figure' AND status IN ('reserved','running','unknown')",[kernel.id,kernel.active_execution_id])).rows[0];
    if(!pub)return null;await recover(pub,kernel);return owned(kernel.owner_user_id,kernel.project_id,kernel.id);
  }
  async function afterStop(kernel) {
    const rows=(await db.query("SELECT * FROM private_r_publications WHERE kernel_id=$1 AND publication_type<>'figure' AND status IN ('reserved','running','unknown')",[kernel.id])).rows;
    for(const pub of rows)await fail(pub,kernel);
  }
  async function publish(userId,projectId,kernelId,raw) {
    const value=input(raw);let kernel=await owned(userId,projectId,kernelId);await checked(kernel);const hash=c.digest(value);
    const known=(await db.query('SELECT id FROM private_r_publications WHERE kernel_id=$1 AND request_id=$2',[kernelId,value.requestId])).rows[0];
    let capabilities;
    if(!known&&value.type!=='figure'){
      capabilities=await probe();
      if(capabilities.state!=='ready'||capabilities.persistentKernel!==true||capabilities.persistentKernelPublications!==true)throw error('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE','Named R output saves are unavailable in this runtime. Existing console commands remain available.',503);
    }
    const reserved=await transaction(async connection=>{
      await lockedAccess(connection,userId,projectId);const spec=specs[value.type];
      const plan=await artifacts.planProduced(connection,userId,projectId,{type:spec.type,formatId:spec.formatId,previousVersionId:value.previousVersionId});
      kernel=(await connection.query('SELECT * FROM private_r_kernels WHERE id=$1 FOR UPDATE',[kernelId])).rows[0];
      const previous=(await connection.query('SELECT * FROM private_r_publications WHERE kernel_id=$1 AND request_id=$2',[kernelId,value.requestId])).rows[0];
      if(previous){if(previous.request_sha256!==hash)throw error('PRIVATE_KERNEL_REQUEST_CONFLICT','This save request already refers to different output settings.',409);return {pub:previous,repeated:true};}
      if(!kernel.runtime_generation)throw error('PRIVATE_KERNEL_PUBLICATION_INVALID','This session has no confirmed R generation.');
      const publicationId=id('pub'),versionId=id('av');let execution,figure,bytes,artifactPolicy,stream=false;
      if(value.type==='figure') {
        execution=(await connection.query("SELECT * FROM private_r_executions WHERE id=$1 AND kernel_id=$2 AND owner_user_id=$3 AND status='completed'",[value.executionId,kernelId,userId])).rows[0];
        if(!execution || execution.kernel_generation!==kernel.runtime_generation || !execution.result_json)throw error('PRIVATE_KERNEL_PUBLICATION_INVALID','The selected completed figure is unavailable.');
        figure=c.result(execution.result_json,kernel,execution).figures[value.figureIndex];if(!figure)throw error('PRIVATE_KERNEL_PUBLICATION_INVALID','The selected completed figure is unavailable.');
        bytes=Buffer.from(figure.data,'base64').length;await artifacts.assertCapacity(connection,userId,projectId,bytes);
      } else {
        if(kernel.status!=='ready'||kernel.active_execution_id||kernel.active_control_id||Date.parse(kernel.expires_at)<=Date.now())throw error('PRIVATE_KERNEL_BUSY','The session must be ready before saving a named R binding.',409);
        if(Number(kernel.next_order)>=c.LIMITS.executions)throw error('PRIVATE_KERNEL_ORDER_LIMIT','Start a new session after 500 commands.',409);
        let brokerPolicy;try{brokerPolicy=validatePrivateRArtifactPolicy(capabilities.privateRArtifactPolicy);}catch{/* An older adapter retains its original serialization bounds. */}
        stream=capabilities.persistentKernelStreamedPublications===true&&Boolean(brokerPolicy);
        // Older adapters keep their original 20 MiB command. Only a verified
        // streamed adapter accepts a quota-bound larger serialization command.
        artifactPolicy=effectivePrivateRArtifactPolicy(capabilities);
        bytes=await artifacts.reserveProducedCapacity(connection,userId,projectId,artifactPolicy.maxOutputBytes);
        if(!stream&&bytes<LEGACY_PUBLICATION_BYTES)throw error('ARTIFACT_STORAGE_LIMIT','The configured limit or remaining managed artifact storage cannot reserve an output on this older R runtime. Free storage or update the server runtime.',409);
        const source=generatePrivateKernelExportSource({publicationId,generation:kernel.runtime_generation,type:value.type,binding:value.binding,...(stream?{stream:true,maxBytes:bytes}:{})});
        execution=(await connection.query(`INSERT INTO private_r_executions(id,kernel_id,project_id,owner_user_id,request_id,kernel_generation,execution_order,status,source_code,source_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9) RETURNING *`,[id('pex'),kernelId,projectId,userId,crypto.randomUUID(),kernel.runtime_generation,Number(kernel.next_order)+1,source,c.digest(source)])).rows[0];
      }
      const provenance=await lineage(connection,kernel,execution);
      if(stream)provenance.artifactPolicy=artifactPolicy;
      const key=storage.projectStorageFileKey(projectId,'artifacts',versionId,'content.'+spec.extension);
      const pub=(await connection.query(`INSERT INTO private_r_publications(id,kernel_id,project_id,owner_user_id,request_id,request_sha256,status,publication_type,name,binding_name,source_execution_id,kernel_generation,kernel_order,figure_index,artifact_id,version_id,previous_version_id,storage_key,reserved_bytes,lineage_json) VALUES($1,$2,$3,$4,$5,$6,'reserved',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,[publicationId,kernelId,projectId,userId,value.requestId,hash,value.type,value.name,value.binding||null,execution.id,kernel.runtime_generation,execution.execution_order,value.figureIndex??null,plan.artifactId,versionId,value.previousVersionId,key,bytes,provenance])).rows[0];
      if(!figure)await connection.query("UPDATE private_r_kernels SET status='running',next_order=$2,active_execution_id=$3,last_activity_at=NOW(),updated_at=NOW() WHERE id=$1",[kernelId,execution.execution_order,execution.id]);
      return {pub,execution,figure,stream};
    });
    const pub=reserved.pub;
    if(reserved.repeated){await recover(pub,kernel);await db.requireProjectRole(userId,projectId,['owner','admin','analyst','viewer']);return present(await rowById(pub.id));}
    if(reserved.figure) {
      try{await transaction(async connection=>{
        await lockedAccess(connection,userId,projectId);await connection.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId]);
        const current=(await connection.query('SELECT * FROM private_r_publications WHERE id=$1 FOR UPDATE',[pub.id])).rows[0];
        if(current.status==='completed')return;if(!['reserved','running'].includes(current.status))throw error('PRIVATE_KERNEL_PUBLICATION_CONFLICT','This figure save already ended or requires receipt recovery.',409);
        // Fence cleanup/recovery before creating the bounded PNG. A delayed
        // writer cannot recreate a key whose reservation was already failed.
        const handle=await fs.open(provider.prepareWrite(pub.storage_key),'wx',0o600);try{await handle.writeFile(Buffer.from(reserved.figure.data,'base64'));await handle.sync();}finally{await handle.close();}
        const file=await provider.inspect(pub.storage_key,{checksumSha256:reserved.figure.sha256,sizeBytes:pub.reserved_bytes});await commit(pub,kernel,file,null,reserved.figure,connection);
      });}
      catch(failure){await fail(pub,kernel);throw failure;}
    } else {
      await db.query("UPDATE private_r_publications SET status='running',updated_at=NOW() WHERE id=$1 AND status='reserved'",[pub.id]);
      await db.query("UPDATE private_r_executions SET status='running',started_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='reserved'",[reserved.execution.id]);
      try {
        await checked(await owned(userId,projectId,kernelId));
        const runtimeOptions=reserved.stream?{transferTimeoutSeconds:pub.lineage_json.artifactPolicy.transferTimeoutSeconds}:undefined;
        const result=await client.export(c.scope(kernel),kernelId,{publicationId:pub.id,type:value.type,binding:value.binding,executionId:reserved.execution.id,order:Number(reserved.execution.execution_order),source:reserved.execution.source_code,internalStorageKey:pub.storage_key,...(reserved.stream?{stream:true,maxBytes:Number(pub.reserved_bytes)}:{})},runtimeOptions);
        await applyExport(pub,kernel,result);
      } catch(failure) {
        const current=await rowById(pub.id);
        if(['PRIVATE_KERNEL_PUBLICATION_INVALID','PRIVATE_KERNEL_INVALID','PRIVATE_KERNEL_STOPPED','PRIVATE_KERNEL_ORDER_INVALID','PRIVATE_KERNEL_BUSY'].includes(failure.code)){await fail(pub,kernel);throw failure;}
        if(!['completed','failed'].includes(current.status))await db.query("UPDATE private_r_publications SET status='unknown',updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','failed')",[pub.id]);
        if(!['completed','failed'].includes(current.status))await transaction(connection=>commandOutcome(connection,kernel,current,null,'unknown'));
        if(denied(failure)){await fail(pub,kernel);throw failure;}
        if(!['PRIVATE_KERNEL_TRANSPORT_UNKNOWN','PRIVATE_KERNEL_RESPONSE_INVALID','PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE'].includes(failure.code))throw failure;
      }
    }
    await db.requireProjectRole(userId,projectId,['owner','admin','analyst','viewer']);return present(await rowById(pub.id));
  }
  async function list(userId,projectId,kernelId,options={}) {
    const kernel=await readAccess(userId,projectId,kernelId);const limit=Number(options.limit??20);let cursor;
    if(!Number.isSafeInteger(limit)||limit<1||limit>30)throw error('PRIVATE_KERNEL_PAGE_INVALID','Select 1–30 saved output receipts.');
    if(options.before!==undefined){try{if(typeof options.before!=='string'||options.before.length>256)throw Error();cursor=JSON.parse(Buffer.from(options.before,'base64url').toString());if(!Array.isArray(cursor)||cursor.length!==2||typeof cursor[0]!=='string'||cursor[0].length>40||!Number.isFinite(Date.parse(cursor[0]))||!c.PUBLICATION_ID.test(cursor[1]))throw Error();}catch{throw error('PRIVATE_KERNEL_PAGE_INVALID','The saved output cursor is invalid.');}}
    const rows=(await db.query(`SELECT * FROM private_r_publications WHERE kernel_id=$1 AND owner_user_id=$2${cursor?" AND (date_trunc('milliseconds',created_at),id)<($4::timestamptz,$5::text)":''} ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $3`,[kernelId,userId,limit+1,...(cursor||[])])).rows;
    const items=[];let bytes=0,last;
    for(let pub of rows.slice(0,limit)){await recover(pub,kernel);pub=await rowById(pub.id);const shown=await present(pub),item={...shown.publication,version:shown.version};const size=Buffer.byteLength(JSON.stringify(item));if(items.length&&bytes+size>768*1024)break;items.push(item);bytes+=size;last=pub;}
    await db.requireProjectRole(userId,projectId,['owner','admin','analyst','viewer']);return {items,nextCursor:last&&rows.length>items.length?Buffer.from(JSON.stringify([time(last.created_at),last.id])).toString('base64url'):null};
  }
  return {publish,list,reconcileActive,afterStop};
}
module.exports={createPrivateKernelPublicationService,validatePublicationInput:input};
