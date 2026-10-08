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
  const provider=createLocalStorageProvider(path.join(directory,'storage'));
  const runtime=createPrivateKernelRuntime({env,provider,environmentManifest:manifest});runtimes.push(runtime);
  await runtime.initialize();check('reference Jupyter adapter is available in the exact pinned environment');
  const scope={ownerUserId:1101,projectId:'private_kernel_acceptance',workspaceId:'workspace1'};
  const kernelId=id('pk_');const started=await runtime.start({...scope,kernelId,environment,inputs:[]});
  validatePrivateKernelStatus(started,{kernelId,environment});check('actual private kernel starts with generation, resources and lifetime');
  const executionScope={...scope,generation:started.generation};let order=0;
  const execute=async source=>runtime.execute(executionScope,kernelId,{executionId:id('pex_'),order:++order,source});
  const firstId=id('pex_'),source='private_value <- 41; private_value';
  const first=await runtime.execute(executionScope,kernelId,{executionId:firstId,order:++order,source});assert.equal(first.status,'completed');
  const repeated=await runtime.execute(executionScope,kernelId,{executionId:firstId,order,source});assert.deepEqual(repeated,first);
  const persisted=await execute('cat(private_value + 1L)');assert.equal(persisted.status,'completed');assert.match(persisted.stdout,/42/);check('variables persist and repeated execution receipts do not rerun source');
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
