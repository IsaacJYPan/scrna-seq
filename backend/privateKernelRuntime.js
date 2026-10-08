'use strict';

// Only the internal broker imports this module. Researcher source enters one
// nonroot, networkless container; Docker credentials and storage handles remain
// in this process. A lost execution is never resubmitted automatically.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const storage = require('./storage');
const { validateEnvironmentManifest, summarizeEnvironmentManifest, assertEnvironmentMatches } = require('./rEnvironment');
const { validatePrivateKernelExportRequest, extractPrivateKernelFile, PRIVATE_KERNEL_PUBLICATION_ID_RE,
  MAX_PRIVATE_KERNEL_EXPORT_BYTES } = require('./privateKernelExports');

const KERNEL_ID = /^pk_[0-9a-f]{16,64}$/;
const GENERATION = /^[0-9a-f]{64}$/;
const CONTAINER_NAME = /^traceomics-kernel-pk_[0-9a-f]{16,64}-[0-9a-f]{12}$/;
const LABEL = 'org.traceomics.private-kernel';
const MAX_SOURCE_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const MAX_STAGED_BYTES = 250 * 1024 * 1024;
const MAX_EXECUTIONS = 500;
const TOMBSTONE_TTL_MS = 300000;
const MAX_TOMBSTONES = 128;
const MAX_RETIRED_IDS = 4096;
function failure(code, message) { return Object.assign(new Error(message), { code, publicSafeHandlerError: true }); }
function utc(milliseconds) { return new Date(milliseconds).toISOString(); }
function scopedId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function validateScope(scope) {
  const ownerUserId=Number(scope?.ownerUserId);
  if (!scope || !Number.isSafeInteger(ownerUserId)||ownerUserId<1||!['projectId','workspaceId'].every(key => scopedId(scope[key]))
      || (scope.generation !== undefined && !GENERATION.test(scope.generation))) {
    throw failure('PRIVATE_KERNEL_INVALID', 'The private R workspace identity is invalid.');
  }
  return { ownerUserId, projectId:scope.projectId, workspaceId:scope.workspaceId,
    ...(scope.generation ? { generation:scope.generation } : {}) };
}
function numberOption(value, fallback, minimum, maximum) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw failure('PRIVATE_KERNEL_CONFIG_INVALID','The private kernel resource policy is invalid.');
  return parsed;
}
function resourcePolicy(env) {
  const memory = String(env.PRIVATE_R_KERNEL_MEMORY_LIMIT || env.EXPERT_R_MEMORY_LIMIT || '8g').toLowerCase();
  const matched = /^(\d+)([mg])$/.exec(memory);
  const memoryBytes = matched ? Number(matched[1]) * (matched[2] === 'g' ? 1024**3 : 1024**2) : NaN;
  numberOption(memoryBytes, 8*1024**3,512*1024**2,8*1024**3);
  const resources = {
    memoryBytes, cpuLimit:numberOption(env.PRIVATE_R_KERNEL_CPU_LIMIT || env.EXPERT_R_CPU_LIMIT,2,0.25,8),
    pidsLimit:numberOption(env.PRIVATE_R_KERNEL_PIDS_LIMIT,256,64,1024),
    idleTimeoutSeconds:numberOption(env.PRIVATE_R_KERNEL_IDLE_SECONDS,900,1,3600),
    maxLifetimeSeconds:numberOption(env.PRIVATE_R_KERNEL_LIFETIME_SECONDS,14400,1,14400),
  };
  return { resources, memory, executionSeconds:numberOption(env.PRIVATE_R_KERNEL_EXECUTION_SECONDS,300,1,600),
    maxActive:numberOption(env.PRIVATE_R_KERNEL_MAX_ACTIVE,2,1,32), maxOwner:numberOption(env.PRIVATE_R_KERNEL_MAX_PER_OWNER,1,1,4) };
}
function validateInputs(raw, projectId) {
  if (!Array.isArray(raw) || raw.length > 6) throw failure('PRIVATE_KERNEL_INPUT_INVALID','Select at most five files and one analysis checkpoint.');
  const ids = new Set(); let checkpoints = 0; let total = 0;
  const inputs = raw.map(input => {
    if (!input || !scopedId(input.id) || !scopedId(input.versionId) || ids.has(input.id)
        || typeof input.name !== 'string' || !input.name || input.name.length > 200 || /[\p{Cc}]/u.test(input.name)
        || !['checkpoint','input'].includes(input.role) || !/^[a-z][a-z0-9_-]{0,39}$/.test(input.type || '')
        || !/^[a-z][a-z0-9_-]{0,19}$/.test(input.format || '')
        || !/^[0-9a-f]{64}$/.test(input.checksumSha256 || '') || !Number.isSafeInteger(input.sizeBytes)
        || input.sizeBytes < 0 || input.sizeBytes > MAX_INPUT_BYTES
        || !storage.isProjectStorageKey(input.internalStorageKey,{projectId})) {
      throw failure('PRIVATE_KERNEL_INPUT_INVALID','A selected input version is invalid or exceeds its size limit.');
    }
    ids.add(input.id); total += input.sizeBytes;
    if (input.role === 'checkpoint') { checkpoints++; if (input.format !== 'rds') throw failure('PRIVATE_KERNEL_INPUT_INVALID','An analysis checkpoint must be an RDS artifact.'); }
    return { id:input.id, versionId:input.versionId, type:input.type, format:input.format, name:input.name,
      internalStorageKey:input.internalStorageKey,checksumSha256:input.checksumSha256,sizeBytes:input.sizeBytes,role:input.role };
  });
  if (checkpoints > 1 || raw.length-checkpoints > 5 || total > MAX_STAGED_BYTES) throw failure('PRIVATE_KERNEL_INPUT_INVALID','The selected input collection exceeds the private kernel limit.');
  return inputs;
}

function runCommand(command,args,{timeoutMs=30000}={}) {
  return new Promise((resolve,reject) => {
    const child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(failure('PRIVATE_KERNEL_UNAVAILABLE','The private kernel container service did not respond.'));},timeoutMs);
    const append=(key,chunk)=>{
      if(key==='stdout')stdout+=chunk.toString('utf8');else stderr=(stderr+chunk.toString('utf8')).slice(-8192);
      if(Buffer.byteLength(stdout)>MAX_RESPONSE_BYTES){child.kill('SIGKILL');finish(failure('PRIVATE_KERNEL_TRANSPORT_FAILED','The private kernel service response exceeds its limit.'));}
    };
    child.stdout.on('data',chunk=>append('stdout',chunk));child.stderr.on('data',chunk=>append('stderr',chunk));
    child.once('error',()=>finish(failure('PRIVATE_KERNEL_UNAVAILABLE','The private kernel container service is unavailable.')));
    child.once('close',code=>code===0?finish(null,{stdout,stderr}):finish(Object.assign(failure('PRIVATE_KERNEL_UNAVAILABLE','The private kernel container command failed.'),{exitCode:code})));
  });
}

// One request may be in flight. Bytes are checked before JSON parsing; an
// untrusted runtime cannot make the broker buffer arbitrarily large output.
function createTransport(child,{onLost,startTimeoutMs=120000}={}) {
  let bytes=Buffer.alloc(0), pending=null, alive=true, readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const startTimer=setTimeout(()=>lost(),startTimeoutMs);
  function lost() {
    if(!alive)return;alive=false;clearTimeout(startTimer);
    const error=failure('PRIVATE_KERNEL_TRANSPORT_FAILED','The private R process stopped; its unsaved variables are unavailable.');
    readyReject(error);if(pending){clearTimeout(pending.timer);pending.reject(error);pending=null;}
    onLost?.();
  }
  child.stdout.on('data',chunk=>{
    if(!alive)return;bytes=Buffer.concat([bytes,chunk]);
    if(bytes.length>MAX_RESPONSE_BYTES+2048){lost();return;}
    while(bytes.includes(10)) {
      const index=bytes.indexOf(10);const line=bytes.subarray(0,index);bytes=bytes.subarray(index+1);
      let value;try{value=JSON.parse(line.toString('utf8'));}catch{lost();return;}
      if(value?.ok===true&&value.event==='ready'){clearTimeout(startTimer);readyResolve(value);}
      else if(pending&&value?.ok===true&&value.event==='execution'&&value.executionId===pending.executionId){const current=pending;pending=null;clearTimeout(current.timer);current.resolve(value);}
      else if(value?.ok===true&&value.event==='stopped') { /* Owned stop confirmation follows container removal. */ }
      else {lost();return;}
    }
  });
  // Diagnostic output stays private and is discarded. Docker stderr is never
  // interpolated into public errors, where it could expose host paths.
  child.stderr.on('data',()=>{});
  child.once('error',lost);child.once('close',lost);child.stdin.on('error',lost);
  return { ready,
    request(executionId,source,timeoutSeconds,publication) {
      if(!alive)return Promise.reject(failure('PRIVATE_KERNEL_TRANSPORT_FAILED','The private kernel is no longer available.'));
      if(pending)return Promise.reject(failure('PRIVATE_KERNEL_BUSY','The private kernel is already executing.'));
      return new Promise((resolve,reject)=>{
        pending={executionId,resolve,reject,timer:setTimeout(lost,(timeoutSeconds+5)*1000)};
        child.stdin.write(JSON.stringify({action:'execute',executionId,source,timeoutSeconds,...(publication?{publication}: {})})+'\n');
      });
    },
    close(){if(alive){try{child.stdin.end(JSON.stringify({action:'stop'})+'\n');}catch{}}lost();child.kill('SIGKILL');},
  };
}

function createPrivateKernelRuntime({env=process.env,provider=storage.createLocalStorageProvider(),environmentManifest,
  runProcessImpl=runCommand,spawnImpl=spawn,clock=Date.now,transportFactory=createTransport,
  extractFileImpl=extractPrivateKernelFile,
  maxRetiredIds=MAX_RETIRED_IDS,maxTombstones=MAX_TOMBSTONES}={}) {
  const policy=resourcePolicy(env), manifest=validateEnvironmentManifest(environmentManifest);
  const environment=summarizeEnvironmentManifest(manifest), image=String(env.EXPERT_R_SANDBOX_IMAGE||'');
  if(image!==manifest.runtime.imageReference)throw failure('R_ENVIRONMENT_MISMATCH','The private kernel image differs from the pinned environment.');
  const workRoot=path.resolve(env.EXPERT_R_SANDBOX_WORK_ROOT||path.join(storage.storageRoot(),'expert-r-sandbox'));
  const kernelRoot=path.join(workRoot,'kernels');
  const endedRoot=path.join(kernelRoot,'ended');
  const rootHash=crypto.createHash('sha256').update(kernelRoot).digest('hex');
  const managerId=crypto.randomBytes(32).toString('hex');
  const records=new Map(),retiredIds=new Set();let initialized=false,publications=false,closed=false,timer=null,lastMetadataSweep=0;
  const target={kind:'service',id:'private-r-kernel',generation:managerId};
  const docker=(args,options)=>runProcessImpl('docker',args,options);
  function retire(record) {
    if(retiredIds.has(record.kernelId))return;
    if(retiredIds.size>=maxRetiredIds)throw failure('PRIVATE_KERNEL_LIFECYCLE_LIMIT','The private kernel broker reached its lifetime session limit. Stop active kernels before restarting the broker.');
    retiredIds.add(record.kernelId);
  }
  function releaseEnded(record) {
    const last=record.lastExecution;
    const retained=[];
    for(const [id,entry] of record.executions||[]) {
      if(entry.publication||id===last?.id){const {result,...small}=entry;void result;retained.push([id,small]);}
    }
    record.executions=new Map(retained);
    if(last)record.lastExecution={id:last.id,order:last.order,status:last.status};
    record.inputs=[];record.transport=null;record.endedAt=record.endedAt||clock();
  }
  async function writeEnded(record,status) {
    // The application database owns immutable IDs across broker restarts.
    // Within this broker lifetime, a bounded set prevents reusing an ended ID;
    // a short tombstone also covers startup/control requests still in flight.
    retire(record);
    const destination=path.join(endedRoot,`${record.kernelId}.json`);
    const temporary=`${destination}.${crypto.randomBytes(8).toString('hex')}.partial`;
    await fsp.writeFile(temporary,JSON.stringify({rootHash,kernelId:record.kernelId,generation:record.generation,status,
      ...(record.scope?{scope:record.scope}:{}),endedAt:utc(clock())}),{flag:'wx',mode:0o600});
    await fsp.rename(temporary,destination);record.endedAt=record.endedAt||clock();
  }
  async function readEnded(kernelId) {
    const destination=path.join(endedRoot,`${kernelId}.json`);
    let stat;try{stat=await fsp.lstat(destination);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw failure('PRIVATE_KERNEL_OWNERSHIP_INVALID','The private kernel lifecycle record is invalid.');
    const value=JSON.parse(await fsp.readFile(destination,'utf8'));
    if(value.rootHash!==rootHash||value.kernelId!==kernelId||!GENERATION.test(value.generation||''))throw failure('PRIVATE_KERNEL_OWNERSHIP_INVALID','The private kernel lifecycle record is invalid.');
    return value;
  }
  function requireRecord(scope,kernelId) {
    scope=validateScope(scope);if(!KERNEL_ID.test(kernelId))throw failure('PRIVATE_KERNEL_NOT_FOUND','The private kernel is unavailable.');
    const record=records.get(kernelId);
    if(!record||['ownerUserId','projectId','workspaceId'].some(key=>record.scope[key]!==scope[key])
        ||(scope.generation&&record.generation!==scope.generation))throw failure('PRIVATE_KERNEL_NOT_FOUND','The private kernel is unavailable.');
    return record;
  }
  function publicRecord(record) {
    return {ok:true,kernelId:record.kernelId,generation:record.generation,status:record.status,
      environment,resources:policy.resources,target,startedAt:utc(record.startedAt),expiresAt:utc(record.startedAt+policy.resources.maxLifetimeSeconds*1000),
      inputs:(record.inputs||[]).map(({internalStorageKey,...input})=>{void internalStorageKey;return input;}),
      ...(record.stoppedAt?{stoppedAt:utc(record.stoppedAt)}:{}),
      ...(record.lastExecution?{lastExecution:record.lastExecution}:{}),
      ...(record.reason?{reason:record.reason}:{}),unsavedState:record.status==='stopped'||record.status==='unknown'?'lost':'available'};
  }
  async function inspectContainer(name) {
    let result;try{result=await docker(['inspect',name,'--format','{"id":{{json .Id}},"labels":{{json .Config.Labels}}}']);}
    catch(error){if(error.exitCode===1)return null;throw error;}
    let value;try{value=JSON.parse(result.stdout);}catch{throw failure('PRIVATE_KERNEL_UNAVAILABLE','Container ownership could not be verified.');}
    if(!/^[0-9a-f]{64}$/.test(value.id||'')||!value.labels)throw failure('PRIVATE_KERNEL_UNAVAILABLE','Container ownership could not be verified.');
    return value;
  }
  async function removeOwned(record) {
    if(!record.containerName)return;
    const inspected=await inspectContainer(record.containerName);
    if(!inspected){record.containerRemoved=true;return;}
    const labels=inspected.labels;
    if(labels[LABEL]!=='true'||labels[`${LABEL}.root`]!==rootHash||labels[`${LABEL}.manager`]!==managerId
        ||labels[`${LABEL}.kernel`]!==record.kernelId||labels[`${LABEL}.generation`]!==record.generation) {
      throw failure('PRIVATE_KERNEL_OWNERSHIP_INVALID','The private kernel container ownership could not be verified.');
    }
    await docker(['rm','-f',inspected.id]);
    record.containerRemoved=true;
  }
  async function removeDirectory(record) {
    if(!record.directory)return;
    if(path.dirname(record.directory)!==kernelRoot||path.basename(record.directory)!==record.kernelId)throw failure('PRIVATE_KERNEL_OWNERSHIP_INVALID','The private workspace could not be safely removed.');
    const stat=await fsp.lstat(record.directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(stat?.isSymbolicLink())throw failure('PRIVATE_KERNEL_OWNERSHIP_INVALID','The private workspace could not be safely removed.');
    if(stat)await fsp.rm(record.directory,{recursive:true,force:true});
  }
  async function terminate(record,reason='stopped') {
    record.stopRequested=true;
    record.publicationAbort?.abort();
    if(record.transport){await removeOwned(record);record.transport.close();}
    if(record.creation)await record.creation.catch(()=>{});
    if(record.pendingPublication)await record.pendingPublication.catch(()=>{});
    for(const entry of record.executions?.values()||[])if(entry.status==='executing')entry.status='unknown';
    if(record.lastExecution?.status==='executing')record.lastExecution={...record.lastExecution,status:'unknown'};
    await writeEnded(record,'stopped');
    await removeOwned(record);record.status='stopped';record.reason=reason;record.stoppedAt=clock();
    record.transport?.close();await removeDirectory(record);releaseEnded(record);
  }
  async function lost(record) {
    if(record.status==='stopped'||record.stopRequested)return;
    if(record.lossCleanup)return record.lossCleanup;
    record.status='unknown';record.reason='process-lost';
    record.publicationAbort?.abort();
    if(record.lastExecution?.status==='executing')record.lastExecution={...record.lastExecution,status:'unknown'};
    record.lossCleanup=(async()=>{try{await writeEnded(record,'unknown');await removeOwned(record);record.transport?.close();
      if(record.pendingPublication)await record.pendingPublication.catch(()=>{});
      for(const entry of record.executions?.values()||[])if(entry.status==='executing')entry.status='unknown';
      await removeDirectory(record);releaseEnded(record);}catch{/* Retry through explicit stop or lifetime sweep. */}})();
    return record.lossCleanup;
  }
  async function reconcile() {
    const result=await docker(['ps','-a','--filter',`label=${LABEL}=true`,'--filter',`label=${LABEL}.root=${rootHash}`,'--format','{{.Names}}']);
    for(const name of String(result.stdout||'').trim().split(/\r?\n/).filter(Boolean)) {
      if(!CONTAINER_NAME.test(name))continue;
      const inspected=await inspectContainer(name);if(!inspected)continue;
      const labels=inspected.labels;
      if(labels[LABEL]!=='true'||labels[`${LABEL}.root`]!==rootHash||!KERNEL_ID.test(labels[`${LABEL}.kernel`]||'')||!GENERATION.test(labels[`${LABEL}.generation`]||'')
          ||name!==`traceomics-kernel-${labels[`${LABEL}.kernel`]}-${labels[`${LABEL}.generation`].slice(0,12)}`)continue;
      await writeEnded({kernelId:labels[`${LABEL}.kernel`],generation:labels[`${LABEL}.generation`]},'unknown');
      await docker(['rm','-f',inspected.id]);
    }
    // Only directories created with our fixed basename and bounded manifest are
    // removed. No researcher-controlled manifest path is followed.
    for(const entry of await fsp.readdir(kernelRoot,{withFileTypes:true})) {
      if(!entry.isDirectory()||entry.isSymbolicLink()||!KERNEL_ID.test(entry.name))continue;
      const directory=path.join(kernelRoot,entry.name);
      let metadata;try{const raw=await fsp.readFile(path.join(directory,'.private-kernel.json'),'utf8');if(Buffer.byteLength(raw)>16384)continue;metadata=JSON.parse(raw);}catch{continue;}
      if(metadata.rootHash===rootHash&&metadata.kernelId===entry.name&&GENERATION.test(metadata.generation||'')) {
        await writeEnded(metadata,'unknown');await removeDirectory({directory,kernelId:entry.name});
      }
    }
  }
  async function initialize() {
    if(initialized)return {supported:true,publications,environment};
    if(env.PRIVATE_R_KERNEL_ENABLED!=='true')throw failure('PRIVATE_KERNEL_DISABLED','Persistent private R kernels are not enabled on this installation.');
    if(closed)throw failure('PRIVATE_KERNEL_UNAVAILABLE','The private kernel broker has stopped.');
    await fsp.mkdir(kernelRoot,{recursive:true,mode:0o700});
    if((await fsp.lstat(kernelRoot)).isSymbolicLink())throw failure('PRIVATE_KERNEL_CONFIG_INVALID','The private kernel work root must be a real directory.');
    await fsp.mkdir(endedRoot,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    if((await fsp.lstat(endedRoot)).isSymbolicLink())throw failure('PRIVATE_KERNEL_CONFIG_INVALID','The private kernel lifecycle root must be a real directory.');
    const inspected=await docker(['image','inspect',image,'--format','{{.Id}}']);
    if(String(inspected.stdout||'').trim()!==environment.imageId)throw failure('R_ENVIRONMENT_MISMATCH','The exact private R image is unavailable.');
    const probeRecord={kernelId:`pk_${crypto.randomBytes(12).toString('hex')}`,generation:crypto.randomBytes(32).toString('hex')};
    probeRecord.containerName=`traceomics-kernel-${probeRecord.kernelId}-${probeRecord.generation.slice(0,12)}`;
    let probe;
    try{probe=await docker(['run','--rm','--name',probeRecord.containerName,
      '--label',`${LABEL}=true`,'--label',`${LABEL}.root=${rootHash}`,'--label',`${LABEL}.manager=${managerId}`,
      '--label',`${LABEL}.kernel=${probeRecord.kernelId}`,'--label',`${LABEL}.generation=${probeRecord.generation}`,
      '--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
      '--user','10001:10001','--pids-limit','64','--memory','512m','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m','--entrypoint','python3',image,
      '/app/private-kernel-bridge.py','--probe'],{timeoutMs:30000});}
    catch{throw failure('PRIVATE_KERNEL_UNSUPPORTED','This pinned R image does not provide the persistent Jupyter kernel adapter.');}
    finally{await removeOwned(probeRecord);}
    let value;try{value=JSON.parse(probe.stdout);}catch{}
    if(!value?.ok||value.protocol!=='jupyter'||value.adapter!==1)throw failure('PRIVATE_KERNEL_UNSUPPORTED','This pinned R image does not provide the persistent Jupyter kernel adapter.');
    publications=value.publications===true;
    await reconcile();initialized=true;
    timer=setInterval(()=>{void sweep().catch(()=>{});},1000);timer.unref?.();
    return {supported:true,publications,environment};
  }
  async function stage(record) {
    record.directory=path.join(kernelRoot,record.kernelId);await fsp.mkdir(record.directory,{mode:0o700});
    await fsp.writeFile(path.join(record.directory,'.private-kernel.json'),JSON.stringify({rootHash,kernelId:record.kernelId,generation:record.generation,managerId,scope:record.scope}),{flag:'wx',mode:0o600});
    const inputDirectory=path.join(record.directory,'input');await fsp.mkdir(inputDirectory,{mode:0o700});
    const staged=[];
    for(const [index,input] of record.inputs.entries()) {
      const filename=`input-${index}.${input.format}`;const destination=path.join(inputDirectory,filename);
      const opened=await provider.openVerifiedRead(input.internalStorageKey,{checksumSha256:input.checksumSha256,sizeBytes:input.sizeBytes});
      try{await pipeline(opened.handle.createReadStream({autoClose:false}),fs.createWriteStream(destination,{flags:'wx',mode:0o444}));}
      finally{await opened.handle.close();}
      // Verify the private copy too, closing the race between source verification
      // and copying a concurrently modified backing file.
      const hash=crypto.createHash('sha256');let size=0;
      for await(const chunk of fs.createReadStream(destination)){hash.update(chunk);size+=chunk.length;}
      if(size!==input.sizeBytes||hash.digest('hex')!==input.checksumSha256)throw failure('PRIVATE_KERNEL_INPUT_INVALID','The selected input changed while its exact version was staged.');
      const {internalStorageKey,...safe}=input;void internalStorageKey;staged.push({...safe,filename});
      await fsp.chmod(destination,0o444);
    }
    await fsp.writeFile(path.join(inputDirectory,'input-manifest.json'),JSON.stringify(staged),{flag:'wx',mode:0o444});
    await fsp.chmod(inputDirectory,0o555);
    return inputDirectory;
  }
  async function start(spec) {
    const scope=validateScope(spec);if(!KERNEL_ID.test(spec.kernelId||''))throw failure('PRIVATE_KERNEL_INVALID','The private kernel ID is invalid.');
    assertEnvironmentMatches(spec.environment,environment);
    const inputs=validateInputs(spec.inputs||[],scope.projectId);
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify({scope,inputs,environment:spec.environment})).digest('hex');
    const existing=records.get(spec.kernelId);
    if(existing){requireRecord(scope,spec.kernelId);if(existing.stopRequested||existing.status==='stopped'||existing.status==='unknown')throw failure('PRIVATE_KERNEL_STOPPED','This kernel generation has ended. Start a new workspace kernel.');if(existing.fingerprint!==fingerprint)throw failure('PRIVATE_KERNEL_CONFLICT','This kernel ID already belongs to another input snapshot.');await existing.creation;return publicRecord(existing);}
    if(!initialized||closed)throw failure('PRIVATE_KERNEL_UNAVAILABLE','The persistent private R runtime is not ready.');
    const ended=await readEnded(spec.kernelId);
    if(ended){if(ended.scope&&['ownerUserId','projectId','workspaceId'].some(key=>ended.scope[key]!==scope[key]))throw failure('PRIVATE_KERNEL_NOT_FOUND','The private kernel is unavailable.');throw failure('PRIVATE_KERNEL_STOPPED','This kernel generation has ended. Start a new workspace kernel.');}
    // Reading the durable tombstone yields to the event loop. A concurrent stop
    // or start may have reserved this ID in that interval; check again before
    // allocating a directory or container.
    const reserved=records.get(spec.kernelId);
    if(reserved){requireRecord(scope,spec.kernelId);if(reserved.stopRequested||reserved.status==='stopped'||reserved.status==='unknown')throw failure('PRIVATE_KERNEL_STOPPED','This kernel generation has ended. Start a new workspace kernel.');if(reserved.fingerprint!==fingerprint)throw failure('PRIVATE_KERNEL_CONFLICT','This kernel ID already belongs to another input snapshot.');await reserved.creation;return publicRecord(reserved);}
    const active=[...records.values()].filter(record=>!['stopped','unknown'].includes(record.status)||(record.containerName&&!record.containerRemoved));
    if(retiredIds.has(spec.kernelId))throw failure('PRIVATE_KERNEL_STOPPED','This kernel generation has ended. Start a new workspace kernel.');
    if(retiredIds.size>=maxRetiredIds)throw failure('PRIVATE_KERNEL_LIFECYCLE_LIMIT','The private kernel broker reached its lifetime session limit. Stop active kernels before restarting the broker.');
    if(records.size-active.length>=maxTombstones)throw failure('PRIVATE_KERNEL_LIFECYCLE_LIMIT','Too many recently ended kernels are retained. Wait briefly before starting another.');
    if(active.length>=policy.maxActive||active.filter(record=>record.scope.ownerUserId===scope.ownerUserId).length>=policy.maxOwner)throw failure('PRIVATE_KERNEL_ADMISSION_LIMIT','The private R kernel capacity is full. Stop an existing kernel and try again.');
    const record={kernelId:spec.kernelId,scope,generation:crypto.randomBytes(32).toString('hex'),status:'starting',startedAt:clock(),lastActivity:clock(),inputs,fingerprint,executions:new Map(),stopRequested:false};
    records.set(record.kernelId,record);
    record.creation=(async()=>{
      try{
        retire(record);
        const inputDirectory=await stage(record);
        if(record.stopRequested)throw failure('PRIVATE_KERNEL_STOPPED','This private R kernel was stopped during startup.');
        record.containerName=`traceomics-kernel-${record.kernelId}-${record.generation.slice(0,12)}`;
        const args=['create','--rm','-i','--name',record.containerName,
          '--label',`${LABEL}=true`,'--label',`${LABEL}.root=${rootHash}`,'--label',`${LABEL}.manager=${managerId}`,
          '--label',`${LABEL}.kernel=${record.kernelId}`,'--label',`${LABEL}.generation=${record.generation}`,
          '--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','10001:10001',
          '--pids-limit',String(policy.resources.pidsLimit),'--memory',policy.memory,'--cpus',String(policy.resources.cpuLimit),
          '--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=512m','--tmpfs','/work:rw,noexec,nosuid,nodev,size=200m,uid=10001,gid=10001,mode=0700',
          '--mount',`type=bind,source=${inputDirectory},target=/work/input,readonly`,
          '--env','HOME=/tmp','--env','JUPYTER_RUNTIME_DIR=/tmp/jupyter-runtime','--entrypoint','python3',image,'/app/private-kernel-bridge.py'];
        // Obtain the daemon's container identity before attaching. A stop during
        // creation waits for this owned reservation; it cannot kill a CLI and
        // then accidentally allow its late daemon request to start a process.
        const created=await docker(args,{timeoutMs:30000});
        record.containerId=String(created.stdout||'').trim();
        if(!/^[0-9a-f]{64}$/.test(record.containerId))throw failure('PRIVATE_KERNEL_START_FAILED','The private container could not be identified.');
        if(record.stopRequested)throw failure('PRIVATE_KERNEL_STOPPED','This private R kernel was stopped during startup.');
        const child=spawnImpl('docker',['start','--attach','--interactive',record.containerId],{windowsHide:true,stdio:['pipe','pipe','pipe']});
        record.transport=transportFactory(child,{onLost:()=>{void lost(record);}});
        await record.transport.ready;
        if(record.stopRequested)throw failure('PRIVATE_KERNEL_STOPPED','This private R kernel was stopped during startup.');
        record.status='ready';record.lastActivity=clock();
      }catch(error){
        record.status='unknown';record.reason='startup-failed';
        await writeEnded(record,'unknown').catch(()=>{});
        await removeOwned(record).catch(()=>{});record.transport?.close();await removeDirectory(record).catch(()=>{});
        if(record.containerRemoved||!record.containerName)releaseEnded(record);
        if(error.publicSafeHandlerError)throw error;
        throw failure('PRIVATE_KERNEL_START_FAILED','The private R kernel could not load its selected inputs. Check the pinned image and input versions.');
      }
    })();
    await record.creation;return publicRecord(record);
  }
  async function inspect(scope,kernelId) {
    const record=requireRecord(scope,kernelId);await expire(record);return publicRecord(record);
  }
  function publicationReceipt(record,executionId,entry) {
    return {ok:true,kernelId:record.kernelId,generation:record.generation,publicationId:entry.publication.publicationId,
      executionId,order:entry.order,status:entry.status,...(entry.result?{result:entry.result}:{}),...(entry.file?{file:entry.file}:{})};
  }
  async function saveOutput(record,spec,evidence) {
    if(!evidence||!Number.isSafeInteger(evidence.sizeBytes)||evidence.sizeBytes<0||evidence.sizeBytes>MAX_PRIVATE_KERNEL_EXPORT_BYTES
        ||!GENERATION.test(evidence.checksumSha256||''))throw failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE','The isolated output evidence is invalid.');
    const inspected=await inspectContainer(record.containerName);
    if(!inspected||inspected.id!==record.containerId||inspected.labels[`${LABEL}.manager`]!==managerId
        ||inspected.labels[`${LABEL}.kernel`]!==record.kernelId||inspected.labels[`${LABEL}.generation`]!==record.generation
        ||inspected.labels[`${LABEL}.root`]!==rootHash||inspected.labels[LABEL]!=='true') {
      throw failure('PRIVATE_KERNEL_OWNERSHIP_INVALID','The private kernel container ownership could not be verified.');
    }
    const temporary=path.join(record.directory,`${crypto.randomBytes(16).toString('hex')}.export`);
    const aborted=new AbortController();record.publicationAbort=aborted;
    let published=false;
    try {
      if(record.stopRequested)throw failure('PRIVATE_KERNEL_STOPPED','The private R kernel was stopped.');
      await extractFileImpl({containerId:record.containerId,filename:spec.filename,destination:temporary,expected:evidence,
        spawnImpl,signal:aborted.signal});
      if(record.stopRequested||record.status!=='executing')throw failure('PRIVATE_KERNEL_STOPPED','The private R kernel was stopped.');
      const stored=await provider.putFileFromPath(temporary,spec.internalStorageKey);published=true;
      if(record.stopRequested||record.status!=='executing')throw failure('PRIVATE_KERNEL_STOPPED','The private R kernel was stopped.');
      if(stored.sizeBytes!==evidence.sizeBytes||stored.checksumSha256!==evidence.checksumSha256)throw failure('PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE','The saved output failed integrity verification.');
      await provider.inspect(spec.internalStorageKey,evidence);
      if(record.stopRequested||record.status!=='executing')throw failure('PRIVATE_KERNEL_STOPPED','The private R kernel was stopped.');
      return {type:spec.type,format:spec.type==='object'?'rds':'csv',internalStorageKey:spec.internalStorageKey,
        checksumSha256:stored.checksumSha256,sizeBytes:stored.sizeBytes};
    } catch(error) {
      if(published)await provider.remove(spec.internalStorageKey).catch(()=>{});
      throw error;
    } finally {
      if(record.publicationAbort===aborted)record.publicationAbort=null;
      await fsp.unlink(temporary).catch(()=>{});
    }
  }
  async function executeOperation(scope,kernelId,{executionId,order,source}={},publication=null) {
    const record=requireRecord(scope,kernelId);await expire(record);
    if(!scopedId(executionId)||!Number.isSafeInteger(order)||order<1||typeof source!=='string'||!source.trim()||Buffer.byteLength(source)>MAX_SOURCE_BYTES||source.includes('\0'))throw failure('PRIVATE_KERNEL_INVALID','The R command is empty, invalid, or exceeds 32 KiB.');
    const hash=crypto.createHash('sha256').update(source).digest('hex');
    const prior=record.executions.get(executionId);
    if(prior){if(prior.order!==order||prior.hash!==hash||Boolean(prior.publication)!==Boolean(publication)
        ||(publication&&JSON.stringify(prior.publication)!==JSON.stringify(publication)))throw failure('PRIVATE_KERNEL_CONFLICT','The execution ID already belongs to a different command.');
      return publication?publicationReceipt(record,executionId,prior):prior.result||{ok:true,kernelId,generation:record.generation,executionId,order,status:prior.status};}
    if(record.status==='executing')throw failure('PRIVATE_KERNEL_BUSY','Wait for the current R command to finish.');
    if(record.status!=='ready')throw failure('PRIVATE_KERNEL_STOPPED','The private R kernel is unavailable; its unsaved variables are lost.');
    if(order!==(record.lastExecution?.order||0)+1)throw failure('PRIVATE_KERNEL_ORDER_INVALID','The R execution order does not match this kernel generation.');
    if(record.executions.size>=MAX_EXECUTIONS)throw failure('PRIVATE_KERNEL_LIFETIME_LIMIT','This kernel has reached its command limit. Start a new kernel.');
    const startedAt=utc(clock()), entry={order,hash,status:'executing',...(publication?{publication}:{})};record.executions.set(executionId,entry);
    record.status='executing';record.lastExecution={id:executionId,order,status:'executing'};record.lastActivity=clock();
    try{
      const value=await record.transport.request(executionId,source,policy.executionSeconds,publication?{filename:publication.filename}:undefined);
      const evidence=value.exportFile;delete value.exportFile;
      const result={...value,ok:true,kernelId,generation:record.generation,executionId,order,startedAt,completedAt:utc(clock())};delete result.event;
      const {validatePrivateKernelExecutionResult}=require('./privateKernelContract');
      const validated=validatePrivateKernelExecutionResult(result,{kernelId,generation:record.generation,executionId,order});
      if(record.stopRequested||['stopped','unknown'].includes(record.status))throw failure('PRIVATE_KERNEL_STOPPED','The private R kernel was stopped.');
      if(publication&&validated.status==='completed') {
        record.pendingPublication=saveOutput(record,publication,evidence);
        try{entry.file=await record.pendingPublication;}finally{record.pendingPublication=null;}
      }
      // Retain one rich result only. Older IDs retain a receipt, preventing rerun,
      // while their durable results are held by the application's journal.
      for(const previous of record.executions.values())delete previous.result;
      entry.status=validated.status;entry.result=validated;
      record.status='ready';record.lastActivity=clock();record.lastExecution={id:executionId,order,status:validated.status,result:validated};
      return publication?publicationReceipt(record,executionId,entry):validated;
    }catch{
      entry.status='unknown';record.lastExecution={id:executionId,order,status:'unknown'};
      await lost(record);
      return publication?publicationReceipt(record,executionId,entry):{ok:true,kernelId,generation:record.generation,executionId,order,status:'unknown'};
    }
  }
  async function execute(scope,kernelId,spec) {return executeOperation(scope,kernelId,spec);}
  async function exportOutput(scope,kernelId,spec) {
    const record=requireRecord(scope,kernelId);
    if(!scope.generation)throw failure('PRIVATE_KERNEL_PUBLICATION_INVALID','The saved output requires an exact kernel generation.');
    if(!publications)throw failure('PRIVATE_KERNEL_PUBLICATION_UNSUPPORTED','This pinned private R image does not support saved outputs.');
    const normalized=validatePrivateKernelExportRequest(spec,{projectId:record.scope.projectId,generation:record.generation});
    for(const [id,entry]of record.executions) {
      if(entry.publication?.publicationId===normalized.publicationId&&id!==spec.executionId)throw failure('PRIVATE_KERNEL_CONFLICT','The publication ID already belongs to another command.');
    }
    // Retain bounded identity/evidence, rather than the generated source itself.
    const {source,executionId,order,...publication}=normalized;void source;void executionId;void order;
    return executeOperation(scope,kernelId,spec,publication);
  }
  async function exportStatus(scope,kernelId,{publicationId}={}) {
    const record=requireRecord(scope,kernelId);await expire(record);
    if(!scope.generation||!PRIVATE_KERNEL_PUBLICATION_ID_RE.test(publicationId||''))throw failure('PRIVATE_KERNEL_PUBLICATION_INVALID','The saved-output identity is invalid.');
    for(const [id,entry]of record.executions)if(entry.publication?.publicationId===publicationId)return publicationReceipt(record,id,entry);
    throw failure('PRIVATE_KERNEL_PUBLICATION_NOT_FOUND','No saved-output command was reserved for this publication.');
  }
  async function stop(scope,kernelId) {
    scope=validateScope(scope);if(!KERNEL_ID.test(kernelId))throw failure('PRIVATE_KERNEL_INVALID','The private kernel ID is invalid.');
    let record=records.get(kernelId);
    if(!record){const ended=initialized?await readEnded(kernelId):null;
      if(ended?.scope&&['ownerUserId','projectId','workspaceId'].some(key=>ended.scope[key]!==scope[key]))throw failure('PRIVATE_KERNEL_NOT_FOUND','The private kernel is unavailable.');
      if(ended&&scope.generation&&ended.generation!==scope.generation)throw failure('PRIVATE_KERNEL_NOT_FOUND','The private kernel is unavailable.');
      record=records.get(kernelId);
      if(!record){record={kernelId,scope,generation:scope.generation||ended?.generation||crypto.randomBytes(32).toString('hex'),status:'stopped',startedAt:clock(),stoppedAt:clock(),stopRequested:true,inputs:[]};
        if(records.size<maxTombstones+policy.maxActive){records.set(kernelId,record);if(initialized)await writeEnded(record,'stopped');}
        else retire(record);
      }
    }
    if(!record.stopRequested||record.creation){requireRecord(scope,kernelId);record.stopRequested=true;
      if(record.transport){await removeOwned(record);record.transport.close();}
      if(record.creation)await record.creation.catch(()=>{});await terminate(record);}
    return {ok:true,kernelId,generation:record.generation,status:'stopped',stoppedAt:utc(record.stoppedAt)};
  }
  async function expire(record) {
    if(['stopped','unknown'].includes(record.status))return;
    const now=clock();if(now-record.startedAt>=policy.resources.maxLifetimeSeconds*1000)await terminate(record,'lifetime-expired');
    else if(record.status==='ready'&&now-record.lastActivity>=policy.resources.idleTimeoutSeconds*1000)await terminate(record,'idle-expired');
  }
  async function sweep(){
    for(const record of records.values()) {
      await expire(record);
      if(record.endedAt&&clock()-record.endedAt>=TOMBSTONE_TTL_MS&&(!record.containerName||record.containerRemoved))records.delete(record.kernelId);
    }
    if(clock()-lastMetadataSweep>=30000) {
      lastMetadataSweep=clock();
      for(const entry of await fsp.readdir(endedRoot,{withFileTypes:true})) {
        if(!entry.isFile()||entry.isSymbolicLink()||!/^pk_[0-9a-f]{16,64}\.json$/.test(entry.name))continue;
        const kernelId=entry.name.slice(0,-5),metadata=await readEnded(kernelId);
        if(metadata&&Number.isFinite(Date.parse(metadata.endedAt))&&clock()-Date.parse(metadata.endedAt)>=TOMBSTONE_TTL_MS) {
          retire(metadata);await fsp.rm(path.join(endedRoot,entry.name),{force:true});
        }
      }
    }
  }
  async function close(){closed=true;if(timer)clearInterval(timer);for(const record of records.values()){record.stopRequested=true;if(record.creation)await record.creation.catch(()=>{});await terminate(record).catch(()=>{});}}
  return {initialize,start,inspect,execute,export:exportOutput,exportStatus,stop,close,sweep,environment,resources:policy.resources};
}
module.exports={createPrivateKernelRuntime,createTransport,runCommand,resourcePolicy,validateInputs,validateScope,
  PRIVATE_KERNEL_ID_RE:KERNEL_ID,PRIVATE_KERNEL_LABEL:LABEL,MAX_PRIVATE_KERNEL_SOURCE_BYTES:MAX_SOURCE_BYTES,MAX_PRIVATE_KERNEL_RESPONSE_BYTES:MAX_RESPONSE_BYTES,
  PRIVATE_KERNEL_TOMBSTONE_TTL_MS:TOMBSTONE_TTL_MS,PRIVATE_KERNEL_MAX_RETIRED_IDS:MAX_RETIRED_IDS};
