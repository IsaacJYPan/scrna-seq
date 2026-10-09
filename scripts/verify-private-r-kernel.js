'use strict';

// A disposable acceptance run against an explicitly pinned local Docker image.
// It creates no application accounts, touches no user runtime configuration and
// removes only the randomly named resources recorded by this process.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createPrivateKernelRuntime, runCommand, PRIVATE_KERNEL_LABEL:LABEL } = require('../backend/privateKernelRuntime');
const { discoverExpertRuntimeEnvironment } = require('../backend/expertSandboxBroker');
const { summarizeEnvironmentManifest,environmentBytes } = require('../backend/rEnvironment');
const { createLocalStorageProvider } = require('../backend/storage');
const { validatePrivateKernelStatus } = require('../backend/privateKernelContract');
const { generatePrivateKernelExportSource } = require('../backend/privateKernelExports');

const image=String(process.env.EXPERT_R_SANDBOX_IMAGE||'');
if(!/^(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/.test(image))throw new Error('Set EXPERT_R_SANDBOX_IMAGE to the reviewed immutable kernel image.');
const reportRoot=path.resolve('playwright/report/private-kernel');
const directory=path.join(reportRoot,`runtime-${crypto.randomBytes(8).toString('hex')}`);
const ownedContainers=[],runtimes=[];let completed=0;
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const id=prefix=>prefix+crypto.randomBytes(12).toString('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const env={...process.env,NODE_ENV:'test',PRIVATE_R_KERNEL_ENABLED:'true',EXPERT_R_SANDBOX_IMAGE:image,EXPERT_R_SANDBOX_WORK_ROOT:path.join(directory,'work')};
function check(name){completed++;console.log(`PASS ${completed}: ${name}`);}
async function main(){
  await fs.mkdir(directory,{recursive:true});
  const manifest=await discoverExpertRuntimeEnvironment(env,runCommand),environment=summarizeEnvironmentManifest(manifest);
  await fs.writeFile(path.join(directory,'environment.json'),environmentBytes(manifest));
  const provider=createLocalStorageProvider({root:path.join(directory,'storage')});
  const runtime=createPrivateKernelRuntime({env,provider,environmentManifest:manifest});runtimes.push(runtime);
  const supported=await runtime.initialize();assert.equal(supported.publications,true);assert.equal(supported.interrupt,true);check('reference Jupyter adapter, publications and independent interruption are available in the exact pinned environment');
  const scope={ownerUserId:1101,projectId:'private_kernel_acceptance',workspaceId:'workspace1'};
  const kernelId=id('pk_');const started=await runtime.start({...scope,kernelId,environment,inputs:[]});
  validatePrivateKernelStatus(started,{kernelId,environment});check('actual private kernel starts with generation, resources and lifetime');
  const executionScope={...scope,generation:started.generation};let order=0;
  const execute=async source=>runtime.execute(executionScope,kernelId,{executionId:id('pex_'),order:++order,source});
  const firstId=id('pex_'),source='private_value <- 41; private_value';
  const first=await runtime.execute(executionScope,kernelId,{executionId:firstId,order:++order,source});assert.equal(first.status,'completed');
  const repeated=await runtime.execute(executionScope,kernelId,{executionId:firstId,order,source});assert.deepEqual(repeated,first);
  const persisted=await execute('cat(private_value + 1L)');assert.equal(persisted.status,'completed');assert.match(persisted.stdout,/42/);check('variables persist and repeated execution receipts do not rerun source');
  const interruptId=id('pex_'),interruptOrder=++order;
  const running=runtime.execute(executionScope,kernelId,{executionId:interruptId,order:interruptOrder,source:'display_table(data.frame(partial=1)); plot(1:3); Sys.sleep(100); private_value <- 999'});
  await sleep(500);
  const controlRequest={executionId:interruptId,order:interruptOrder,requestId:crypto.randomUUID()};
  for(const changed of [{ownerUserId:1102},{workspaceId:'workspace_other'},{generation:'f'.repeat(64)}])await assert.rejects(runtime.interrupt({...executionScope,...changed},kernelId,controlRequest),{code:'PRIVATE_KERNEL_NOT_FOUND'});
  await assert.rejects(runtime.interrupt(executionScope,kernelId,{...controlRequest,order:interruptOrder+1}),{code:'PRIVATE_KERNEL_CONTROL_INVALID'});
  const [interruptedOnce,interruptedTwice]=await Promise.all([runtime.interrupt(executionScope,kernelId,controlRequest),runtime.interrupt(executionScope,kernelId,{...controlRequest,requestId:crypto.randomUUID()})]);
  assert.deepEqual(interruptedTwice,interruptedOnce);assert.equal(interruptedOnce.outcome,'interrupted',JSON.stringify(interruptedOnce));assert.equal(interruptedOnce.idleConfirmed,true);assert.equal(interruptedOnce.status,'ready');
  const interruptedExecution=await running;assert.deepEqual(interruptedOnce.execution,interruptedExecution);assert.equal(interruptedExecution.error.code,'PRIVATE_KERNEL_INTERRUPTED');assert.equal(interruptedExecution.interrupted,true);assert.deepEqual(interruptedExecution.tables,[]);assert.deepEqual(interruptedExecution.figures,[]);
  assert.deepEqual(await runtime.interrupt(executionScope,kernelId,controlRequest),interruptedOnce);
  const retainedAfterInterrupt=await execute('cat(private_value)');assert.equal(retainedAfterInterrupt.status,'completed');assert.match(retainedAfterInterrupt.stdout,/41/);
  check('actual long R command interrupts once with terminal+idle evidence, drops partial rich outputs and preserves earlier variables');
  const caughtId=id('pex_'),caughtOrder=++order;
  const catchesSignal=runtime.execute(executionScope,kernelId,{executionId:caughtId,order:caughtOrder,source:'tryCatch(Sys.sleep(100), interrupt=function(e) cat("caught signal")); cat(" normal completion")'});await sleep(500);
  const caught=await runtime.interrupt(executionScope,kernelId,{executionId:caughtId,order:caughtOrder,requestId:crypto.randomUUID()});
  assert.equal(caught.outcome,'already-completed',JSON.stringify(caught));assert.equal(caught.idleConfirmed,true);assert.equal((await catchesSignal).status,'completed');assert.match(caught.execution.stdout,/caught signal.*normal completion/s);assert.equal(caught.execution.interrupted,undefined);
  check('R code that catches its signal is recorded as natural completion without fabricated interrupted evidence');
  await execute('assign("complete table ` α", data.frame(cell=paste0("cell",seq_len(125)),count=seq_len(125)),envir=.GlobalEnv); full_object <- list(table=get("complete table ` α"), note="snapshot")');
  function publication(scoped,type,binding,nextOrder) {
    const publicationId=id('pub_'),version=id('av_'),spec={publicationId,type,binding,executionId:id('pex_'),order:nextOrder,
      internalStorageKey:`projects/${scope.projectId}/artifacts/${version}/content.${type==='object'?'rds':'csv'}`};
    spec.source=generatePrivateKernelExportSource({...spec,generation:scoped.generation});return spec;
  }
  const savedTableCommand=publication(executionScope,'table','complete table ` α',++order);
  const savedTable=await runtime.export(executionScope,kernelId,savedTableCommand);assert.equal(savedTable.status,'completed',JSON.stringify(savedTable));
  assert.equal(savedTable.file.format,'csv');const savedCsv=await fs.readFile(provider.resolveKey(savedTable.file.internalStorageKey));
  assert.equal(savedCsv.toString('utf8').trim().split('\n').length,126);assert.match(savedCsv.toString('utf8'),/"cell125",125/);
  assert.equal(digest(savedCsv),savedTable.file.checksumSha256);await provider.inspect(savedTable.file.internalStorageKey,savedTable.file);
  check('a named complete data frame publishes all 125 rows rather than only its bounded preview');
  await execute('assign("complete table ` α", data.frame(changed=999), envir=.GlobalEnv)');
  const repeatedTable=await runtime.export(executionScope,kernelId,savedTableCommand);
  assert.deepEqual(repeatedTable.file,savedTable.file);assert.equal((await runtime.exportStatus(executionScope,kernelId,{publicationId:savedTableCommand.publicationId})).file.checksumSha256,savedTable.file.checksumSha256);
  check('later binding edits and publication retries preserve the original immutable bytes');
  const savedObjectCommand=publication(executionScope,'object','full_object',++order);
  const savedObject=await runtime.export(executionScope,kernelId,savedObjectCommand);assert.equal(savedObject.status,'completed',JSON.stringify(savedObject));
  await provider.inspect(savedObject.file.internalStorageKey,savedObject.file);assert.equal(savedObject.file.format,'rds');
  check('an existing global R object is serialized only in the private container and stored with exact evidence');
  await assert.rejects(runtime.export(executionScope,kernelId,{...savedObjectCommand,source:savedObjectCommand.source+'\ncat(1)'}),{code:'PRIVATE_KERNEL_PUBLICATION_INVALID'});
  await assert.rejects(runtime.export({...executionScope,generation:'f'.repeat(64)},kernelId,savedObjectCommand),{code:'PRIVATE_KERNEL_NOT_FOUND'});
  for(const binding of ['private_value','missing_binding']) {
    const invalid=await runtime.export(executionScope,kernelId,publication(executionScope,'table',binding,++order));
    assert.equal(invalid.status,'failed');assert.equal(invalid.file,undefined);
  }
  await execute('oversize <- data.frame(value=strrep("x", 21L*1024L*1024L))');
  const oversize=await runtime.export(executionScope,kernelId,publication(executionScope,'table','oversize',++order));
  assert.equal(oversize.status,'failed');assert.match(oversize.result.error.message,/20 MiB/);assert.equal(oversize.file,undefined);
  check('invalid source, generation, missing binding, wrong table type and oversized output fail without saved bytes');
  const table=await execute('display_table(data.frame(cell=c("a","b"), count=c(2,3)), name="Counts")');assert.equal(table.status,'completed');assert.deepEqual(table.tables[0].columns,['cell','count']);assert.deepEqual(table.tables[0].rows,[['a',2],['b',3]]);check('bounded typed tables use a validated rich MIME adapter');
  const figure=await execute('plot(1:3, c(2,4,3), main="Private inspection")');await fs.writeFile(path.join(directory,'plot-result.json'),JSON.stringify(figure));assert.equal(figure.status,'completed',JSON.stringify(figure));assert.equal(figure.figures[0]?.mimeType,'image/png',JSON.stringify({...figure,figures:figure.figures?.map(value=>({...value,data:'<omitted>'}))}));assert.equal(digest(Buffer.from(figure.figures[0].data,'base64')),figure.figures[0].sha256);await fs.writeFile(path.join(directory,'inspection.png'),Buffer.from(figure.figures[0].data,'base64'));check('actual R plot is transported as a bounded verified PNG');
  const warning=await execute('warning("inspect warning"); cat("continued")');assert.equal(warning.status,'completed');assert.match(warning.warnings.join(''),/inspect warning/);
  const error=await execute('stop("inspect failure")');assert.equal(error.status,'failed');assert.match(error.error.message,/inspect failure/);assert.match((await execute('cat(private_value)')).stdout,/41/);check('warnings and actionable R errors preserve earlier private variables');
  const bounded=await execute('cat(strrep("x", 100000)); warning(strrep("w",12000))');assert.equal(bounded.status,'completed');assert.equal(bounded.truncated,true);assert.ok(Buffer.byteLength(bounded.stdout)<=65536);assert.ok(Buffer.byteLength(JSON.stringify(bounded.warnings))<=8192);check('oversized stdout and diagnostics are visibly truncated while the kernel survives');
  await assert.rejects(execute('x'.repeat(32769)),{code:'PRIVATE_KERNEL_INVALID'});order--;check('source limit rejects the command before it changes execution order');
  const otherScope={ownerUserId:1102,projectId:scope.projectId,workspaceId:'workspace2'},otherId=id('pk_');
  const other=await runtime.start({...otherScope,kernelId:otherId,environment,inputs:[]});
  await assert.rejects(runtime.start({ownerUserId:1103,projectId:scope.projectId,workspaceId:'workspace3',kernelId:id('pk_'),environment,inputs:[]}),{code:'PRIVATE_KERNEL_ADMISSION_LIMIT'});check('actual concurrent-kernel admission rejects an additional owner before allocation');
  const isolated=await runtime.execute({...otherScope,generation:other.generation},otherId,{executionId:id('pex_'),order:1,source:'cat(exists("private_value")); cat(Sys.getenv("DOCKER_HOST")); cat(file.exists("/var/run/docker.sock"))'});assert.equal(isolated.status,'completed');assert.match(isolated.stdout,/FALSEFALSE/);
  await assert.rejects(runtime.inspect(otherScope,kernelId),{code:'PRIVATE_KERNEL_NOT_FOUND'});
  await execute('writeLines("unsaved", "private-only.txt")');
  const files=await runtime.execute({...otherScope,generation:other.generation},otherId,{executionId:id('pex_'),order:2,source:'cat(file.exists("/work/private-only.txt"))'});assert.match(files.stdout,/FALSE/);check('another owner cannot reach variables, files, broker credentials or the kernel scope');
  const names=await runCommand('docker',['ps','--filter',`label=${LABEL}.kernel=${kernelId}`,'--format','{{.Names}}']);
  const inspected=JSON.parse((await runCommand('docker',['inspect',names.stdout.trim(),'--format','{{json .HostConfig}}'])).stdout);
  assert.equal(inspected.NetworkMode,'none');assert.equal(inspected.ReadonlyRootfs,true);assert.equal(inspected.Privileged,false);assert.ok(inspected.CapDrop.includes('ALL'));assert.equal(inspected.Memory,started.resources.memoryBytes);check('real Docker host configuration enforces the declared network/filesystem/resource boundary');
  await runtime.stop(otherScope,otherId);
  const restoredId=id('pk_'),objectInput={id:'saved_object',versionId:'object_version',type:'object',format:'rds',name:'object.rds',role:'input',
    internalStorageKey:savedObject.file.internalStorageKey,checksumSha256:savedObject.file.checksumSha256,sizeBytes:savedObject.file.sizeBytes};
  const restored=await runtime.start({...otherScope,kernelId:restoredId,environment,inputs:[objectInput]});
  const reopened=await runtime.execute({...otherScope,generation:restored.generation},restoredId,{executionId:id('pex_'),order:1,source:'restored_object <- read_input("saved_object"); stopifnot(nrow(restored_object$table)==125L, restored_object$table$count[[125L]]==125L, identical(restored_object$note,"snapshot")); cat("reopened saved object")'});
  assert.equal(reopened.status,'completed',JSON.stringify(reopened));assert.match(reopened.stdout,/reopened saved object/);await runtime.stop(otherScope,restoredId);
  check('published RDS reopens with its exact saved values on a separate compatible kernel');
  const busy=execute('Sys.sleep(100); private_value <- 99');await sleep(500);await runtime.stop(executionScope,kernelId);assert.equal((await busy).status,'unknown');assert.equal((await runtime.inspect(executionScope,kernelId)).unsavedState,'lost');await assert.rejects(runtime.start({...scope,kernelId,environment,inputs:[]}),{code:'PRIVATE_KERNEL_STOPPED'});check('stopping a busy kernel confirms removal and reports unknown command completion with lost unsaved memory');

  const inputKey='projects/private_kernel_acceptance/artifacts/table1/table.csv',csv=Buffer.from('cell,count\na,2\nb,3\n');
  const inputPath=provider.resolveKey(inputKey);await fs.mkdir(path.dirname(inputPath),{recursive:true});await fs.writeFile(inputPath,csv);
  const input={id:'table1',versionId:'version1',type:'table',format:'csv',name:'table.csv',role:'input',internalStorageKey:inputKey,checksumSha256:digest(csv),sizeBytes:csv.length};
  const inputId=id('pk_');const loaded=await runtime.start({...scope,kernelId:inputId,environment,inputs:[input]});
  const read=await runtime.execute({...scope,generation:loaded.generation},inputId,{executionId:id('pex_'),order:1,source:'selected <- read_input("table1"); cat(sum(selected$count)); display_table(selected)'});assert.equal(read.status,'completed');assert.match(read.stdout,/5/);assert.deepEqual(read.tables[0].rows,[['a',2],['b',3]]);assert.ok(!JSON.stringify(loaded).includes(inputKey));check('exact checksum-verified input versions load inside the private process');
  await runtime.stop(scope,inputId);
  await assert.rejects(runtime.start({...scope,kernelId:id('pk_'),environment,inputs:[{...input,checksumSha256:'0'.repeat(64)}]}),{code:'PRIVATE_KERNEL_START_FAILED'});check('unavailable exact input bytes fail instead of substituting another version');
  const deadId=id('pk_'),dead=await runtime.start({...scope,kernelId:deadId,environment,inputs:[]});
  const killed=await runtime.execute({...scope,generation:dead.generation},deadId,{executionId:id('pex_'),order:1,source:'system(sprintf("kill -KILL %d", Sys.getpid()))'});assert.equal(killed.status,'unknown');assert.equal((await runtime.inspect(scope,deadId)).status,'unknown');await assert.rejects(runtime.start({...scope,kernelId:deadId,environment,inputs:[]}),{code:'PRIVATE_KERNEL_STOPPED'});check('a dead R subprocess loses memory and never silently restarts or reruns its generation');
  const slowId=id('pk_'),slow=await runtime.start({...scope,kernelId:slowId,environment,inputs:[]}),slowScope={...scope,generation:slow.generation};
  await runtime.execute(slowScope,slowId,{executionId:id('pex_'),order:1,source:'makeActiveBinding("slow_value", function(value) { Sys.sleep(100); data.frame(count=1L) }, .GlobalEnv)'});
  const interruptedSpec=publication(slowScope,'table','slow_value',2),interruptedSave=runtime.export(slowScope,slowId,interruptedSpec);await sleep(500);
  const interruptedSaving=await runtime.interrupt(slowScope,slowId,{executionId:interruptedSpec.executionId,order:2,requestId:crypto.randomUUID()});
  assert.equal(interruptedSaving.outcome,'interrupted',JSON.stringify(interruptedSaving));assert.equal(interruptedSaving.status,'ready');assert.equal((await interruptedSave).status,'failed');assert.equal((await runtime.exportStatus(slowScope,slowId,{publicationId:interruptedSpec.publicationId})).file,undefined);await assert.rejects(provider.inspect(interruptedSpec.internalStorageKey));
  check('interrupt during actual serialization has a failed ordered receipt and no partial saved artifact');
  const slowSpec=publication(slowScope,'table','slow_value',3),pendingSave=runtime.export(slowScope,slowId,slowSpec);await sleep(500);await runtime.stop(slowScope,slowId);
  const interrupted=await pendingSave;assert.equal(interrupted.status,'unknown');assert.equal(interrupted.file,undefined);
  assert.equal((await runtime.exportStatus(slowScope,slowId,{publicationId:slowSpec.publicationId})).status,'unknown');assert.equal((await runtime.export(slowScope,slowId,slowSpec)).status,'unknown');
  await assert.rejects(provider.inspect(slowSpec.internalStorageKey));check('stop during publication records unknown completion with no file and never reruns serialization');
  const unsafeId=id('pk_'),unsafe=await runtime.start({...scope,kernelId:unsafeId,environment,inputs:[]}),unsafeScope={...scope,generation:unsafe.generation};
  await runtime.execute(unsafeScope,unsafeId,{executionId:id('pex_'),order:1,source:'value <- data.frame(x=1); unlink("/work/export",recursive=TRUE); stopifnot(file.symlink("/work/input","/work/export"))'});
  const unsafeSpec=publication(unsafeScope,'table','value',2),unsafeResult=await runtime.export(unsafeScope,unsafeId,unsafeSpec);
  assert.equal(unsafeResult.status,'unknown');assert.equal(unsafeResult.file,undefined);await assert.rejects(provider.inspect(unsafeSpec.internalStorageKey));
  check('a replaced export-directory symlink is rejected without following a container path or publishing bytes');
  const immuneId=id('pk_'),immune=await runtime.start({...scope,kernelId:immuneId,environment,inputs:[]}),immuneScope={...scope,generation:immune.generation},immuneExecution=id('pex_');
  const immuneRun=runtime.execute(immuneScope,immuneId,{executionId:immuneExecution,order:1,source:'repeat { tryCatch(Sys.sleep(100), interrupt=function(e) invisible(NULL)) }'});await sleep(500);
  const unconfirmed=await runtime.interrupt(immuneScope,immuneId,{executionId:immuneExecution,order:1,requestId:crypto.randomUUID()});
  assert.equal(unconfirmed.outcome,'unconfirmed',JSON.stringify(unconfirmed));assert.equal(unconfirmed.idleConfirmed,false);assert.equal(unconfirmed.status,'unknown');assert.equal((await immuneRun).status,'unknown');
  await assert.rejects(runtime.execute(immuneScope,immuneId,{executionId:id('pex_'),order:2,source:'1'}),{code:'PRIVATE_KERNEL_STOPPED'});
  check('an interrupt-immune R command is bounded, loses its generation and requires explicit fresh restart without a rerun');
  const stopRaceId=id('pk_'),stopRace=await runtime.start({...scope,kernelId:stopRaceId,environment,inputs:[]}),stopRaceScope={...scope,generation:stopRace.generation},stopRaceExecution=id('pex_');
  const racingRun=runtime.execute(stopRaceScope,stopRaceId,{executionId:stopRaceExecution,order:1,source:'Sys.sleep(100)'});await sleep(500);
  const racingControl=runtime.interrupt(stopRaceScope,stopRaceId,{executionId:stopRaceExecution,order:1,requestId:crypto.randomUUID()}),racingStop=runtime.stop(stopRaceScope,stopRaceId);
  await racingStop;await racingControl;await racingRun;assert.equal((await runtime.inspect(stopRaceScope,stopRaceId)).status,'stopped');
  check('actual stop/control race removes its owned process and never resurrects ready');
  await runtime.close();

  const quotaEnv={...env,EXPERT_R_SANDBOX_WORK_ROOT:path.join(directory,'quota-work'),PRIVATE_R_KERNEL_IDLE_SECONDS:'2',PRIVATE_R_KERNEL_LIFETIME_SECONDS:'40'};
  const quota=createPrivateKernelRuntime({env:quotaEnv,provider,environmentManifest:manifest});runtimes.push(quota);await quota.initialize();
  const idleId=id('pk_');await quota.start({...scope,kernelId:idleId,environment,inputs:[]});await sleep(2500);assert.equal((await quota.inspect(scope,idleId)).reason,'idle-expired');check('actual idle expiry stops its owned container and distinguishes lost memory');

  // Simulate a broker crash with one owned orphan and one separately owned
  // control container. Reconciliation may terminate only the first.
  const rootHash=digest(path.join(env.EXPERT_R_SANDBOX_WORK_ROOT,'kernels'));
  const orphanId=id('pk_'),generation=crypto.randomBytes(32).toString('hex');
  const orphanName=`traceomics-kernel-${orphanId}-${generation.slice(0,12)}`;
  const controlName=`traceomics-kernel-control-${crypto.randomBytes(12).toString('hex')}`;
  for(const [name,labels]of [[orphanName,[`${LABEL}=true`,`${LABEL}.root=${rootHash}`,`${LABEL}.kernel=${orphanId}`,`${LABEL}.generation=${generation}`]],[controlName,[`${LABEL}=true`,`${LABEL}.root=${'f'.repeat(64)}`]]]) {
    const args=['run','-d','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','10001:10001','--memory','512m','--pids-limit','64','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m','--entrypoint','Rscript'];
    for(const label of labels)args.push('--label',label);
    const created=(await runCommand('docker',[...args,image,'--vanilla','-e','Sys.sleep(100)'])).stdout.trim();ownedContainers.push(created);
  }
  const reconciler=createPrivateKernelRuntime({env,provider,environmentManifest:manifest});runtimes.push(reconciler);await reconciler.initialize();
  await assert.rejects(runCommand('docker',['inspect',orphanName]));assert.equal((await runCommand('docker',['inspect',controlName,'--format','{{.State.Running}}'])).stdout.trim(),'true');await assert.rejects(reconciler.start({...scope,kernelId:orphanId,environment,inputs:[]}),{code:'PRIVATE_KERNEL_STOPPED'});check('broker startup reconciles only labeled owned orphans, retains ended IDs and leaves a foreign container running');
  console.log(JSON.stringify({ok:true,checks:completed,image,environment:environment.id,artifactDirectory:directory}));
}
void main().catch(error=>{console.error(`FAIL ${error.code||error.message}`);if(error.code==='ERR_ASSERTION')console.error(error.message);process.exitCode=1;}).finally(async()=>{
  for(const runtime of runtimes.reverse())await runtime.close().catch(()=>{});
  for(const container of ownedContainers)await runCommand('docker',['rm','-f',container]).catch(()=>{});
});
