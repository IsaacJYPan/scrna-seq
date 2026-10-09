import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const { createPrivateKernelRuntime, createTransport, resourcePolicy, PRIVATE_KERNEL_LABEL:LABEL } = require('./privateKernelRuntime');
const { environmentFixture } = require('./_r-environment-test-utils');
const { createLocalStorageProvider } = require('./storage');
const { generatePrivateKernelExportSource } = require('./privateKernelExports');
const directories=[], runtimes=[];
afterEach(async()=>{for(const runtime of runtimes.splice(0))await runtime.close();for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
const scope={ownerUserId:1,projectId:'project1',workspaceId:'workspace1'};
const kernelId=`pk_${'a'.repeat(24)}`;
const secondId=`pk_${'b'.repeat(24)}`;
const executionId=`pex_${'1'.repeat(24)}`;
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function fixture(options={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'private-kernel-test-'));directories.push(directory);
  const {manifest,reference}=environmentFixture();let now=Date.now(),requests=0,controls=0;
  const calls=[],containers=new Map(),transports=[];
  const provider=createLocalStorageProvider({root:path.join(directory,'storage')});
  const commands=async(_command,args)=>{
    calls.push(args);
    if(args[0]==='image')return{stdout:reference.imageId};
    if(args[0]==='run') {if(options.unsupported)throw new Error('no adapter');return{stdout:JSON.stringify({ok:true,protocol:'jupyter',adapter:1,...(options.publications===false?{}:{publications:true}),...(options.interrupts===false?{}:{interrupt:true})})};}
    if(args[0]==='create') {
      const labels={};for(let i=0;i<args.length;i++){if(args[i]==='--label'){const equal=args[i+1].indexOf('=');labels[args[i+1].slice(0,equal)]=args[i+1].slice(equal+1);}}
      const value={id:crypto.randomBytes(32).toString('hex'),labels};containers.set(args[args.indexOf('--name')+1],value);return{stdout:value.id};
    }
    if(args[0]==='ps')return{stdout:[...containers.keys()].join('\n')};
    if(args[0]==='inspect') {const value=containers.get(args[1]);if(!value)throw Object.assign(new Error('missing'),{exitCode:1});return{stdout:JSON.stringify(value)};}
    if(args[0]==='rm') {for(const [name,value]of containers){if(value.id===args[2])containers.delete(name);}return{stdout:''};}
    throw new Error('Unexpected Docker operation');
  };
  const spawnImpl=(_command,args)=>{
    calls.push(args);return{};
  };
  const transportFactory=(_child,{onLost})=>{
    let closed=false;
    const transport={ready:options.ready?.promise||Promise.resolve({ok:true}),
      async request(id,source,_timeout,publication){requests++;return options.result?options.result(id,source,publication):{ok:true,event:'execution',executionId:id,status:'completed',stdout:`run ${requests}`,warnings:[],error:null,tables:[],figures:[],truncated:false};},
      async interrupt(controlId,id){controls++;return options.interrupt?options.interrupt(controlId,id):{ok:true,event:'control',controlId,executionId:id,idleConfirmed:true,outcome:'already-completed'};},
      close(){if(closed)return;closed=true;onLost();options.ready?.reject(new Error('closed'));},lose:onLost};transports.push(transport);return transport;
  };
  const env={NODE_ENV:'test',PRIVATE_R_KERNEL_ENABLED:'true',EXPERT_R_SANDBOX_IMAGE:reference.imageId,EXPERT_R_SANDBOX_WORK_ROOT:path.join(directory,'work'),...options.env};
  const admittedProvider=options.mutateDuringStage?{...provider,async openVerifiedRead(key,expected){const opened=await provider.openVerifiedRead(key,expected);await options.mutateDuringStage(provider,key);return opened;}}:provider;
  const runtime=createPrivateKernelRuntime({env,provider:options.provider||(options.wrapProvider?options.wrapProvider(admittedProvider):admittedProvider),environmentManifest:manifest,runProcessImpl:commands,spawnImpl,transportFactory,extractFileImpl:options.extractFileImpl,clock:()=>now,maxRetiredIds:options.maxRetiredIds,maxTombstones:options.maxTombstones});
  runtimes.push(runtime);
  const start=(id=kernelId,extra={})=>runtime.start({...scope,kernelId:id,environment:reference,inputs:[],...extra});
  const restart=()=>{const restarted=createPrivateKernelRuntime({env,provider,environmentManifest:manifest,runProcessImpl:commands,spawnImpl,transportFactory,clock:()=>now});runtimes.push(restarted);return restarted;};
  return{runtime,start,reference,directory,calls,containers,provider,transports,restart,requests:()=>requests,controls:()=>controls,advance:ms=>now+=ms};
}
describe('persistent private R runtime ownership and lifecycle',()=>{
  it('independently probes transport and retains exact image, limits and owned resources',async()=>{
    const f=await fixture();await f.runtime.initialize();const status=await f.start();
    expect(status).toMatchObject({ok:true,kernelId,status:'ready',environment:f.reference,resources:{memoryBytes:8*1024**3,cpuLimit:2,pidsLimit:256,idleTimeoutSeconds:900,maxLifetimeSeconds:14400}});
    expect(status.generation).toMatch(/^[0-9a-f]{64}$/);expect(status.target.generation).toMatch(/^[0-9a-f]{64}$/);
    const args=f.calls.find(args=>args[0]==='create');
    for(const value of ['--read-only','none','ALL','no-new-privileges','10001:10001',f.reference.imageId])expect(args).toContain(value);
    expect(args.join(' ')).not.toMatch(/docker\.sock|DOCKER_HOST|TOKEN|PASSWORD|--publish|--privileged/);
    expect(args[args.indexOf('--mount')+1]).toMatch(/target=\/work\/input,readonly$/);
    await f.runtime.stop({...scope,generation:status.generation},kernelId);expect(f.containers.size).toBe(0);
    await expect(f.start()).rejects.toMatchObject({code:'PRIVATE_KERNEL_STOPPED'});
  });
  it('keeps unsupported and disabled persistent transport separate from one-shot R',async()=>{
    const unsupported=await fixture({unsupported:true});await expect(unsupported.runtime.initialize()).rejects.toMatchObject({code:'PRIVATE_KERNEL_UNSUPPORTED'});
    const disabled=await fixture({env:{PRIVATE_R_KERNEL_ENABLED:'false'}});await expect(disabled.runtime.initialize()).rejects.toMatchObject({code:'PRIVATE_KERNEL_DISABLED'});
    expect(disabled.calls).toHaveLength(0);
  });
  it('requires exact owner, project, workspace and generation for every operation',async()=>{
    const f=await fixture();await f.runtime.initialize();const status=await f.start();
    for(const change of [{ownerUserId:2},{projectId:'project2'},{workspaceId:'workspace2'},{generation:'f'.repeat(64)}]) {
      const forged={...scope,generation:status.generation,...change};
      for(const invoke of [()=>f.runtime.inspect(forged,kernelId),()=>f.runtime.stop(forged,kernelId),()=>f.runtime.execute(forged,kernelId,{executionId,order:1,source:'x <- 1'})])await expect(invoke()).rejects.toMatchObject({code:'PRIVATE_KERNEL_NOT_FOUND'});
    }
    expect((await f.runtime.inspect(scope,kernelId)).status).toBe('ready');
  });
  it('stages immutable verified versions without storage keys in runtime or public manifest',async()=>{
    const f=await fixture();const key='projects/project1/artifacts/art1/table.csv';
    const destination=f.provider.resolveKey(key);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,'cell,count\na,2\n');
    const bytes=await readFile(destination);const input={id:'art1',versionId:'av1',type:'table',format:'csv',name:'table.csv',role:'input',internalStorageKey:key,checksumSha256:crypto.createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length};
    await f.runtime.initialize();const status=await f.start(kernelId,{inputs:[input]});
    const staged=JSON.parse(await readFile(path.join(f.directory,'work','kernels',kernelId,'input','input-manifest.json'),'utf8'));
    expect(staged[0]).toMatchObject({id:'art1',versionId:'av1',filename:'input-0.csv',checksumSha256:input.checksumSha256});
    expect(JSON.stringify(staged)+JSON.stringify(status)).not.toContain('internalStorageKey');expect(JSON.stringify(staged)).not.toContain(key);
    await f.runtime.stop(scope,kernelId);
    await expect(f.start(secondId,{inputs:[{...input,checksumSha256:'b'.repeat(64)}]})).rejects.toMatchObject({code:'PRIVATE_KERNEL_START_FAILED'});
  });
  it('enforces resource admission before allocation and idle/total lifetimes',async()=>{
    const f=await fixture({env:{PRIVATE_R_KERNEL_IDLE_SECONDS:'10',PRIVATE_R_KERNEL_LIFETIME_SECONDS:'20'}});await f.runtime.initialize();await f.start();
    await expect(f.start(secondId)).rejects.toMatchObject({code:'PRIVATE_KERNEL_ADMISSION_LIMIT'});
    f.advance(10001);await f.runtime.sweep();expect((await f.runtime.inspect(scope,kernelId)).reason).toBe('idle-expired');
    await f.start(secondId);f.advance(20001);await f.runtime.sweep();expect((await f.runtime.inspect(scope,secondId)).reason).toBe('lifetime-expired');expect(f.containers.size).toBe(0);
    for(const env of [{PRIVATE_R_KERNEL_MEMORY_LIMIT:'1t'},{PRIVATE_R_KERNEL_MEMORY_LIMIT:'64g'},{PRIVATE_R_KERNEL_CPU_LIMIT:'0'},{PRIVATE_R_KERNEL_MAX_ACTIVE:'0'}])expect(()=>resourcePolicy(env)).toThrow();
  });
  it('stop before startup creates a tombstone and startup cancellation removes only its container',async()=>{
    const f=await fixture();await f.runtime.initialize();await f.runtime.stop(scope,kernelId);await expect(f.start()).rejects.toMatchObject({code:'PRIVATE_KERNEL_STOPPED'});
    const ready=deferred(),pending=await fixture({ready});await pending.runtime.initialize();const creation=pending.start();
    const rejection=expect(creation).rejects.toMatchObject({code:'PRIVATE_KERNEL_START_FAILED'});
    while(!pending.transports.length)await new Promise(resolve=>setTimeout(resolve,5));
    await pending.runtime.stop(scope,kernelId);await rejection;expect(pending.containers.size).toBe(0);expect((await pending.runtime.inspect(scope,kernelId)).status).toBe('stopped');
  });
  it('never removes a container when current labels no longer prove ownership',async()=>{
    const f=await fixture();await f.runtime.initialize();await f.start();
    [...f.containers.values()][0].labels[`${LABEL}.manager`]='f'.repeat(64);
    await expect(f.runtime.stop(scope,kernelId)).rejects.toMatchObject({code:'PRIVATE_KERNEL_OWNERSHIP_INVALID'});expect(f.containers.size).toBe(1);
    expect(f.calls.filter(args=>args[0]==='rm')).toHaveLength(0);
  });
  it('serializes duplicate starts and preserves ended generations across broker restart',async()=>{
    const ready=deferred(),f=await fixture({ready});await f.runtime.initialize();
    const first=f.start(),second=f.start();while(!f.transports.length)await new Promise(resolve=>setTimeout(resolve,5));
    ready.resolve({ok:true});const [a,b]=await Promise.all([first,second]);expect(a.generation).toBe(b.generation);expect(f.transports).toHaveLength(1);
    await f.runtime.stop(scope,kernelId);await f.runtime.close();const restarted=f.restart();await restarted.initialize();
    await expect(restarted.start({...scope,kernelId,environment:f.reference,inputs:[]})).rejects.toMatchObject({code:'PRIVATE_KERNEL_STOPPED'});
  });
  it('rejects a backing file changed after verification and before the private copy',async()=>{
    const f=await fixture({mutateDuringStage:async(provider,key)=>writeFile(provider.resolveKey(key),'a,b\n1,9\n')});
    const key='projects/project1/artifacts/art1/table.csv',bytes=Buffer.from('a,b\n1,2\n');await mkdir(path.dirname(f.provider.resolveKey(key)),{recursive:true});await writeFile(f.provider.resolveKey(key),bytes);
    await f.runtime.initialize();await expect(f.start(kernelId,{inputs:[{id:'art1',versionId:'av1',type:'table',format:'csv',name:'table.csv',role:'input',internalStorageKey:key,checksumSha256:crypto.createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length}]})).rejects.toMatchObject({code:'PRIVATE_KERNEL_INPUT_INVALID'});
    expect(f.transports).toHaveLength(0);
  });
  it('releases ended previews and private input metadata, expires tombstones and keeps IDs retired',async()=>{
    const f=await fixture();await f.runtime.initialize();await f.start();
    await f.runtime.execute(scope,kernelId,{executionId,order:1,source:'print(1)'});await f.runtime.stop(scope,kernelId);
    const stopped=await f.runtime.inspect(scope,kernelId);expect(stopped.lastExecution.result).toBeUndefined();expect(stopped.inputs).toEqual([]);
    f.advance(300001);await f.runtime.sweep();await expect(f.runtime.inspect(scope,kernelId)).rejects.toMatchObject({code:'PRIVATE_KERNEL_NOT_FOUND'});
    await expect(readFile(path.join(f.directory,'work','kernels','ended',kernelId+'.json'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(f.start()).rejects.toMatchObject({code:'PRIVATE_KERNEL_STOPPED'});expect(f.containers.size).toBe(0);
  });
  it('bounds recent ended kernels and lifetime IDs without dropping an in-flight tombstone',async()=>{
    const f=await fixture({maxTombstones:1,maxRetiredIds:2});await f.runtime.initialize();await f.start();await f.runtime.stop(scope,kernelId);
    await expect(f.start(secondId)).rejects.toMatchObject({code:'PRIVATE_KERNEL_LIFECYCLE_LIMIT'});
    f.advance(300001);await f.runtime.sweep();await f.start(secondId);await f.runtime.stop(scope,secondId);f.advance(300001);await f.runtime.sweep();
    await expect(f.start(`pk_${'c'.repeat(24)}`)).rejects.toMatchObject({code:'PRIVATE_KERNEL_LIFECYCLE_LIMIT'});await expect(f.start()).rejects.toMatchObject({code:'PRIVATE_KERNEL_STOPPED'});
  });
});
describe('private execution order and transport',()=>{
  it('receipts prevent duplicate source dispatch and reject changed command or skipped order',async()=>{
    const f=await fixture();await f.runtime.initialize();const state=await f.start();const scoped={...scope,generation:state.generation};
    const command={executionId,order:1,source:'x <- 42'};const first=await f.runtime.execute(scoped,kernelId,command);
    expect(first).toMatchObject({status:'completed',order:1,stdout:'run 1'});expect(await f.runtime.execute(scoped,kernelId,command)).toEqual(first);expect(f.requests()).toBe(1);
    await expect(f.runtime.execute(scoped,kernelId,{...command,source:'x <- 43'})).rejects.toMatchObject({code:'PRIVATE_KERNEL_CONFLICT'});
    await expect(f.runtime.execute(scoped,kernelId,{...command,executionId:`pex_${'2'.repeat(24)}`,order:3})).rejects.toMatchObject({code:'PRIVATE_KERNEL_ORDER_INVALID'});
    await expect(f.runtime.execute(scoped,kernelId,{...command,executionId:`pex_${'3'.repeat(24)}`,order:2,source:'x'.repeat(32769)})).rejects.toMatchObject({code:'PRIVATE_KERNEL_INVALID'});
  });
  it('reports in-flight repeats, blocks concurrent source, and marks transport loss unknown without retry',async()=>{
    const pending=deferred();const f=await fixture({result:()=>pending.promise});await f.runtime.initialize();await f.start();
    const command={executionId,order:1,source:'Sys.sleep(2)'};const executing=f.runtime.execute(scope,kernelId,command);
    while(f.requests()===0)await new Promise(resolve=>setTimeout(resolve,5));
    expect(await f.runtime.execute(scope,kernelId,command)).toMatchObject({status:'executing'});
    await expect(f.runtime.execute(scope,kernelId,{...command,executionId:`pex_${'2'.repeat(24)}`,order:2})).rejects.toMatchObject({code:'PRIVATE_KERNEL_BUSY'});
    pending.reject(new Error('lost'));expect(await executing).toMatchObject({status:'unknown'});
    expect((await f.runtime.inspect(scope,kernelId)).unsavedState).toBe('lost');
    expect(await f.runtime.execute(scope,kernelId,command)).toMatchObject({status:'unknown'});expect(f.requests()).toBe(1);expect(f.containers.size).toBe(0);
  });
  it('invalid or oversized output stops its private process instead of publishing a fabricated completion',async()=>{
    const f=await fixture({result:id=>({ok:true,event:'execution',executionId:id,status:'completed',stdout:'x'.repeat(65537),warnings:[],error:null,tables:[],figures:[],truncated:false})});
    await f.runtime.initialize();await f.start();expect(await f.runtime.execute(scope,kernelId,{executionId,order:1,source:'print(1)'})).toMatchObject({status:'unknown'});expect(f.containers.size).toBe(0);
  });
  it('bounds NDJSON before parsing and requires a matching execution ID',async()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};let losses=0;
    const transport=createTransport(child,{onLost:()=>losses++,startTimeoutMs:1000});child.stdout.write('{"ok":true,"event":"ready"}\n');await transport.ready;
    const response=transport.request(executionId,'print(1)',1);child.stdout.write('{"ok":true,"event":"execution","executionId":"wrong"}\n');
    await expect(response).rejects.toMatchObject({code:'PRIVATE_KERNEL_TRANSPORT_FAILED'});expect(losses).toBe(1);
    const other=new EventEmitter();other.stdout=new PassThrough();other.stderr=new PassThrough();other.stdin=new PassThrough();other.kill=()=>{};
    const oversized=createTransport(other,{startTimeoutMs:1000});const ready=expect(oversized.ready).rejects.toMatchObject({code:'PRIVATE_KERNEL_TRANSPORT_FAILED'});other.stdout.write(Buffer.alloc(1048576+2049));await ready;
  });
});

describe('independent cooperative private R controls',()=>{
  const terminal=(id,extra={})=>({ok:true,event:'execution',executionId:id,status:'completed',stdout:'earlier value',warnings:[],error:null,tables:[],figures:[],truncated:false,...extra});
  const command={executionId,order:1,source:'Sys.sleep(60)'};
  const request={executionId,order:1,requestId:'12345678-1234-4123-8123-123456789abc'};
  const waitForRequest=async f=>{while(!f.requests())await new Promise(resolve=>setTimeout(resolve,2));};
  it('interrupts only the exact active command, confirms terminal+idle and permits next source without rerunning',async()=>{
    const pending=deferred();const f=await fixture({result:id=>id===executionId?pending.promise:terminal(id),interrupt:async(controlId,id)=>{
      pending.resolve(terminal(id,{status:'failed',interrupted:true,error:{code:'PRIVATE_KERNEL_INTERRUPTED',message:'R execution was interrupted.'}}));
      return {ok:true,event:'control',controlId,executionId:id,idleConfirmed:true,outcome:'interrupted'};
    }});await f.runtime.initialize();const started=await f.start(),scoped={...scope,generation:started.generation};
    const execution=f.runtime.execute(scoped,kernelId,command);await waitForRequest(f);
    const [first,second]=await Promise.all([f.runtime.interrupt(scoped,kernelId,request),f.runtime.interrupt(scoped,kernelId,{...request,requestId:crypto.randomUUID()})]);
    expect(first).toEqual(second);expect(first).toMatchObject({outcome:'interrupted',status:'ready',idleConfirmed:true,execution:{executionId,order:1,status:'failed',interrupted:true,error:{code:'PRIVATE_KERNEL_INTERRUPTED'}}});
    expect(await execution).toEqual(first.execution);expect(f.controls()).toBe(1);expect(f.requests()).toBe(1);
    expect(await f.runtime.interrupt(scoped,kernelId,request)).toEqual(first);expect(f.controls()).toBe(1);
    expect((await f.runtime.execute(scoped,kernelId,{executionId:'pex_next',order:2,source:'cat(earlier_value)'})).status).toBe('completed');
    const old=await f.runtime.interrupt(scoped,kernelId,request);expect(old.execution).toBeUndefined();expect(f.controls()).toBe(1);
  });
  it('rejects wrong scope, missing generation, stale order and stale command before signaling',async()=>{
    const pending=deferred();const f=await fixture({result:()=>pending.promise});await f.runtime.initialize();const started=await f.start(),scoped={...scope,generation:started.generation};
    const execution=f.runtime.execute(scoped,kernelId,command);await waitForRequest(f);
    for(const changed of [{ownerUserId:2},{projectId:'project2'},{workspaceId:'workspace2'},{generation:'f'.repeat(64)}])await expect(f.runtime.interrupt({...scoped,...changed},kernelId,request)).rejects.toMatchObject({code:'PRIVATE_KERNEL_NOT_FOUND'});
    await expect(f.runtime.interrupt(scope,kernelId,request)).rejects.toMatchObject({code:'PRIVATE_KERNEL_CONTROL_INVALID'});
    for(const changed of [{order:2},{executionId:'pex_stale'},{requestId:'invalid'}])await expect(f.runtime.interrupt(scoped,kernelId,{...request,...changed})).rejects.toMatchObject({code:'PRIVATE_KERNEL_CONTROL_INVALID'});
    expect(f.controls()).toBe(0);pending.resolve(terminal(executionId));await execution;
    expect(await f.runtime.interrupt(scoped,kernelId,request)).toMatchObject({outcome:'already-completed',idleConfirmed:true,execution:{status:'completed'}});expect(f.controls()).toBe(0);
    await f.runtime.execute(scoped,kernelId,{executionId:'pex_next',order:2,source:'next'});
    await expect(f.runtime.interrupt(scoped,kernelId,request)).rejects.toMatchObject({code:'PRIVATE_KERNEL_CONTROL_INVALID'});
  });
  it('keeps old persistent images available while independently rejecting interrupt support',async()=>{
    const f=await fixture({interrupts:false});expect(await f.runtime.initialize()).toMatchObject({supported:true,publications:true,interrupt:false});const started=await f.start();
    await expect(f.runtime.interrupt({...scope,generation:started.generation},kernelId,request)).rejects.toMatchObject({code:'PRIVATE_KERNEL_INTERRUPT_UNSUPPORTED'});expect(f.controls()).toBe(0);
    expect((await f.runtime.execute(scope,kernelId,{...command,source:'1'})).status).toBe('completed');
  });
  it('natural completion racing an interrupt returns the exact completed result',async()=>{
    const pending=deferred();const f=await fixture({result:()=>pending.promise,interrupt:async(controlId,id)=>{pending.resolve(terminal(id));return {ok:true,event:'control',controlId,executionId:id,idleConfirmed:true,outcome:'already-completed'};}});
    await f.runtime.initialize();const started=await f.start(),scoped={...scope,generation:started.generation};const execution=f.runtime.execute(scoped,kernelId,command);await waitForRequest(f);
    const reply=await f.runtime.interrupt(scoped,kernelId,request);expect(reply).toMatchObject({outcome:'already-completed',status:'ready',idleConfirmed:true});expect(reply.execution).toEqual(await execution);
  });
  it('reports executing and blocks new source until a pending control settles after natural completion',async()=>{
    const pending=deferred(),control=deferred();const f=await fixture({result:()=>pending.promise,interrupt:async()=>{pending.resolve(terminal(executionId));return control.promise;}});
    await f.runtime.initialize();const started=await f.start(),scoped={...scope,generation:started.generation};const execution=f.runtime.execute(scoped,kernelId,command);await waitForRequest(f);
    const interrupting=f.runtime.interrupt(scoped,kernelId,request);while(!f.controls())await new Promise(resolve=>setTimeout(resolve,2));await execution;
    expect((await f.runtime.inspect(scoped,kernelId)).status).toBe('executing');await expect(f.runtime.execute(scoped,kernelId,{executionId:'pex_next',order:2,source:'next'})).rejects.toMatchObject({code:'PRIVATE_KERNEL_BUSY'});
    control.resolve({ok:true,event:'control',controlId:request.requestId,executionId,idleConfirmed:true,outcome:'already-completed'});
    expect(await interrupting).toMatchObject({outcome:'already-completed',status:'ready',idleConfirmed:true});expect((await f.runtime.inspect(scoped,kernelId)).status).toBe('ready');
  });
  it('unconfirmed or contradictory control cannot return ready and destroys owned unsaved state',async()=>{
    for(const interrupted of [false,true]){
      const pending=deferred();const f=await fixture({result:()=>pending.promise,interrupt:async(controlId,id)=>{pending.resolve(terminal(id));return {ok:true,event:'control',controlId,executionId:id,idleConfirmed:interrupted,outcome:'interrupted'};}});
      await f.runtime.initialize();const started=await f.start(),scoped={...scope,generation:started.generation};const execution=f.runtime.execute(scoped,kernelId,command);await waitForRequest(f);
      const reply=await f.runtime.interrupt(scoped,kernelId,request);await execution;expect(reply).toMatchObject({outcome:'unconfirmed',status:'unknown',idleConfirmed:false});expect(f.containers.size).toBe(0);
      await expect(f.runtime.execute(scoped,kernelId,{executionId:'pex_next',order:2,source:'1'})).rejects.toMatchObject({code:'PRIVATE_KERNEL_STOPPED'});expect(f.requests()).toBe(1);
    }
  });
  it('stop racing control cannot resurrect ready or assert a confirmed interruption',async()=>{
    const pending=deferred(),control=deferred();const f=await fixture({result:()=>pending.promise,interrupt:()=>control.promise});await f.runtime.initialize();const started=await f.start(),scoped={...scope,generation:started.generation};
    const execution=f.runtime.execute(scoped,kernelId,command);await waitForRequest(f);const interrupting=f.runtime.interrupt(scoped,kernelId,request);while(!f.controls())await new Promise(resolve=>setTimeout(resolve,2));
    const stopping=f.runtime.stop(scoped,kernelId);pending.resolve(terminal(executionId));control.resolve({ok:true,idleConfirmed:true,outcome:'already-completed'});
    await stopping;expect(await execution).toMatchObject({status:'unknown'});expect(await interrupting).toMatchObject({outcome:'unconfirmed',idleConfirmed:false});expect((await f.runtime.inspect(scoped,kernelId)).status).toBe('stopped');expect(f.containers.size).toBe(0);
  });
  it('multiplexes a bounded control response without consuming the pending execution receipt',async()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};const requests=[];child.stdin.on('data',chunk=>requests.push(JSON.parse(chunk.toString())));
    const transport=createTransport(child,{startTimeoutMs:1000,controlTimeoutMs:1000});child.stdout.write('{"ok":true,"event":"ready"}\n');await transport.ready;
    const executing=transport.request(executionId,'Sys.sleep(60)',60),controlling=transport.interrupt(request.requestId,executionId);expect(requests.map(value=>value.action)).toEqual(['execute','interrupt']);
    child.stdout.write(JSON.stringify(terminal(executionId))+'\n'+JSON.stringify({ok:true,event:'control',executionId,controlId:request.requestId,idleConfirmed:true,outcome:'already-completed'})+'\n');
    expect(await executing).toMatchObject({executionId,status:'completed'});expect(await controlling).toMatchObject({idleConfirmed:true});transport.close();
  });
  it('control timeout rejects both pending paths with transport loss instead of leaving an active command',async()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};let losses=0;
    const transport=createTransport(child,{onLost:()=>losses++,startTimeoutMs:1000,controlTimeoutMs:10});child.stdout.write('{"ok":true,"event":"ready"}\n');await transport.ready;
    const executing=expect(transport.request(executionId,'immune',60)).rejects.toMatchObject({code:'PRIVATE_KERNEL_TRANSPORT_FAILED'}),controlling=expect(transport.interrupt(request.requestId,executionId)).rejects.toMatchObject({code:'PRIVATE_KERNEL_TRANSPORT_FAILED'});
    await Promise.all([executing,controlling]);expect(losses).toBe(1);
  });
});

describe('private output publication receipts and handoff',()=>{
  const bytes=Buffer.from('cell,count\na,2\nb,3\n'),evidence={sizeBytes:bytes.length,checksumSha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  const publicationId=`pub_${'c'.repeat(24)}`,key='projects/project1/artifacts/av_export/content.csv';
  async function exportFixture(extra={}) {
    const f=await fixture({result:(id,_source,publication)=>({ok:true,event:'execution',executionId:id,status:'completed',stdout:'saved',warnings:[],error:null,tables:[],figures:[],truncated:false,
      ...(publication?{exportFile:evidence}:{})}),extractFileImpl:async({destination})=>{await writeFile(destination,bytes,{flag:'wx'});return{filePath:destination,...evidence};},...extra});
    await f.runtime.initialize();const state=await f.start(),scoped={...scope,generation:state.generation};
    const command={publicationId,type:'table',binding:'complete table',executionId,order:1,internalStorageKey:key};
    command.source=generatePrivateKernelExportSource({...command,generation:state.generation});
    return{...f,scoped,command};
  }
  it('publishes verified bytes once and retains original evidence across later commands and stop',async()=>{
    const f=await exportFixture();const first=await f.runtime.export(f.scoped,kernelId,f.command);
    expect(first).toMatchObject({status:'completed',publicationId,file:{type:'table',format:'csv',internalStorageKey:key,...evidence}});
    expect(await readFile(f.provider.resolveKey(key))).toEqual(bytes);
    expect(await f.runtime.export(f.scoped,kernelId,f.command)).toEqual(first);expect(f.requests()).toBe(1);
    await f.runtime.execute(f.scoped,kernelId,{executionId:'pex_later',order:2,source:'value <- 9'});
    const retained=await f.runtime.exportStatus(f.scoped,kernelId,{publicationId});expect(retained.file).toEqual(first.file);expect(retained.result).toBeUndefined();
    expect((await f.runtime.export(f.scoped,kernelId,f.command)).file).toEqual(first.file);expect(f.requests()).toBe(2);
    await f.runtime.stop(f.scoped,kernelId);expect((await f.runtime.exportStatus(f.scoped,kernelId,{publicationId})).file).toEqual(first.file);
  });
  it('requires the exact generated source, generation and publication command identity',async()=>{
    const f=await exportFixture();
    await expect(f.runtime.export(scope,kernelId,f.command)).rejects.toMatchObject({code:'PRIVATE_KERNEL_PUBLICATION_INVALID'});
    await expect(f.runtime.export(f.scoped,kernelId,{...f.command,source:f.command.source+'\nprint(1)'})).rejects.toMatchObject({code:'PRIVATE_KERNEL_PUBLICATION_INVALID'});
    await f.runtime.export(f.scoped,kernelId,f.command);
    for(const change of [{executionId:'pex_new',order:2},{internalStorageKey:'projects/project1/artifacts/av_other/content.csv'}])await expect(f.runtime.export(f.scoped,kernelId,{...f.command,...change})).rejects.toMatchObject({code:'PRIVATE_KERNEL_CONFLICT'});
    await expect(f.runtime.execute(f.scoped,kernelId,f.command)).rejects.toMatchObject({code:'PRIVATE_KERNEL_CONFLICT'});
    await expect(f.runtime.exportStatus({...f.scoped,generation:'f'.repeat(64)},kernelId,{publicationId})).rejects.toMatchObject({code:'PRIVATE_KERNEL_NOT_FOUND'});
    await expect(f.runtime.exportStatus(f.scoped,kernelId,{publicationId:`pub_${'e'.repeat(24)}`})).rejects.toMatchObject({code:'PRIVATE_KERNEL_PUBLICATION_NOT_FOUND'});
    expect(f.requests()).toBe(1);
  });
  it('keeps old persistent images available while rejecting unsupported publication before dispatch',async()=>{
    const f=await exportFixture({publications:false});
    expect(await f.runtime.initialize()).toMatchObject({supported:true,publications:false});
    await expect(f.runtime.export(f.scoped,kernelId,f.command)).rejects.toMatchObject({code:'PRIVATE_KERNEL_PUBLICATION_UNSUPPORTED'});
    expect(f.requests()).toBe(0);expect((await f.runtime.execute(f.scoped,kernelId,{executionId,order:1,source:'1'})).status).toBe('completed');
  });
  it('returns failed R serialization without creating bytes or stopping the workspace',async()=>{
    const f=await exportFixture({result:id=>({ok:true,event:'execution',executionId:id,status:'failed',stdout:'',warnings:[],error:{message:'Table publication requires a data frame.',code:'R_ERROR'},tables:[],figures:[],truncated:false})});
    const result=await f.runtime.export(f.scoped,kernelId,f.command);expect(result).toMatchObject({status:'failed',result:{status:'failed'}});expect(result.file).toBeUndefined();
    await expect(readFile(f.provider.resolveKey(key))).rejects.toMatchObject({code:'ENOENT'});expect((await f.runtime.inspect(f.scoped,kernelId)).status).toBe('ready');
  });
  it('interrupts serialization with an exact failed receipt and no partial artifact bytes',async()=>{
    const pending=deferred();const f=await exportFixture({result:()=>pending.promise,interrupt:async(controlId,id)=>{
      pending.resolve({ok:true,event:'execution',executionId:id,status:'failed',interrupted:true,stdout:'',warnings:[],error:{code:'PRIVATE_KERNEL_INTERRUPTED',message:'R execution was interrupted.'},tables:[],figures:[],truncated:false});
      return {ok:true,event:'control',controlId,executionId:id,idleConfirmed:true,outcome:'interrupted'};
    }});const saving=f.runtime.export(f.scoped,kernelId,f.command);while(!f.requests())await new Promise(resolve=>setTimeout(resolve,2));
    const interrupted=await f.runtime.interrupt(f.scoped,kernelId,{executionId,order:1,requestId:crypto.randomUUID()});
    expect(interrupted).toMatchObject({outcome:'interrupted',status:'ready',idleConfirmed:true,execution:{interrupted:true,status:'failed'}});
    const result=await saving;expect(result).toMatchObject({status:'failed',result:interrupted.execution});expect(result.file).toBeUndefined();await expect(readFile(f.provider.resolveKey(key))).rejects.toMatchObject({code:'ENOENT'});
    expect((await f.runtime.exportStatus(f.scoped,kernelId,{publicationId})).status).toBe('failed');expect(f.requests()).toBe(1);
  });
  it('waits for publication byte handoff before returning a naturally completed interrupt receipt',async()=>{
    const handoff=deferred();let writing=false;
    const f=await exportFixture({wrapProvider:provider=>({...provider,async putFileFromPath(source,key){writing=true;await handoff.promise;return provider.putFileFromPath(source,key);}})});
    const saving=f.runtime.export(f.scoped,kernelId,f.command);while(!writing)await new Promise(resolve=>setTimeout(resolve,2));
    let settled=false;const interrupting=f.runtime.interrupt(f.scoped,kernelId,{executionId,order:1,requestId:crypto.randomUUID()}).then(value=>{settled=true;return value;});
    while(!f.controls())await new Promise(resolve=>setTimeout(resolve,2));await new Promise(resolve=>setTimeout(resolve,5));expect(settled).toBe(false);expect((await f.runtime.inspect(f.scoped,kernelId)).status).toBe('executing');
    await expect(f.runtime.execute(f.scoped,kernelId,{executionId:'pex_other',order:2,source:'1'})).rejects.toMatchObject({code:'PRIVATE_KERNEL_BUSY'});
    handoff.resolve();expect(await interrupting).toMatchObject({outcome:'already-completed',status:'ready',idleConfirmed:true,execution:{status:'completed'}});expect((await saving).file).toMatchObject(evidence);
  });
  it('holds execution admission through transfer and confirms no late file after a stop/write race',async()=>{
    const handoff=deferred();let writing=false;
    const f=await exportFixture({wrapProvider:provider=>({...provider,async putFileFromPath(source,key){writing=true;await handoff.promise;return provider.putFileFromPath(source,key);}})});
    const saving=f.runtime.export(f.scoped,kernelId,f.command);while(!writing)await new Promise(resolve=>setTimeout(resolve,2));
    expect((await f.runtime.inspect(f.scoped,kernelId)).status).toBe('executing');
    expect((await f.runtime.export(f.scoped,kernelId,f.command)).status).toBe('executing');
    await expect(f.runtime.execute(f.scoped,kernelId,{executionId:'pex_other',order:2,source:'value<-2'})).rejects.toMatchObject({code:'PRIVATE_KERNEL_BUSY'});
    const stopped=f.runtime.stop(f.scoped,kernelId);handoff.resolve();await stopped;
    const result=await saving;expect(result.status).toBe('unknown');expect(result.file).toBeUndefined();
    await expect(readFile(f.provider.resolveKey(key))).rejects.toMatchObject({code:'ENOENT'});
    expect((await f.runtime.exportStatus(f.scoped,kernelId,{publicationId})).status).toBe('unknown');expect(f.requests()).toBe(1);expect(f.containers.size).toBe(0);
  });
  it('makes invalid output evidence and extraction failure unknown and never retries serialization',async()=>{
    for(const options of [{extractFileImpl:async()=>{throw new Error('changed file');}},
      {result:id=>({ok:true,event:'execution',executionId:id,status:'completed',stdout:'',warnings:[],error:null,tables:[],figures:[],truncated:false,exportFile:{...evidence,sizeBytes:20*1024*1024+1}})}]) {
      const f=await exportFixture(options);const result=await f.runtime.export(f.scoped,kernelId,f.command);expect(result.status).toBe('unknown');expect(result.file).toBeUndefined();
      expect((await f.runtime.exportStatus(f.scoped,kernelId,{publicationId})).status).toBe('unknown');expect((await f.runtime.export(f.scoped,kernelId,f.command)).status).toBe('unknown');expect(f.requests()).toBe(1);
    }
  });
});
