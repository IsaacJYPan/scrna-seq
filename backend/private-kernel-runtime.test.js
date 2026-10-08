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
const directories=[], runtimes=[];
afterEach(async()=>{for(const runtime of runtimes.splice(0))await runtime.close();for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
const scope={ownerUserId:1,projectId:'project1',workspaceId:'workspace1'};
const kernelId=`pk_${'a'.repeat(24)}`;
const secondId=`pk_${'b'.repeat(24)}`;
const executionId=`pex_${'1'.repeat(24)}`;
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function fixture(options={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'private-kernel-test-'));directories.push(directory);
  const {manifest,reference}=environmentFixture();let now=Date.now(),requests=0;
  const calls=[],containers=new Map(),transports=[];
  const provider=createLocalStorageProvider(path.join(directory,'storage'));
  const commands=async(_command,args)=>{
    calls.push(args);
    if(args[0]==='image')return{stdout:reference.imageId};
    if(args[0]==='run') {if(options.unsupported)throw new Error('no adapter');return{stdout:JSON.stringify({ok:true,protocol:'jupyter',adapter:1})};}
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
      async request(id,source){requests++;return options.result?options.result(id,source):{ok:true,event:'execution',executionId:id,status:'completed',stdout:`run ${requests}`,warnings:[],error:null,tables:[],figures:[],truncated:false};},
      close(){if(closed)return;closed=true;onLost();options.ready?.reject(new Error('closed'));},lose:onLost};transports.push(transport);return transport;
  };
  const env={NODE_ENV:'test',PRIVATE_R_KERNEL_ENABLED:'true',EXPERT_R_SANDBOX_IMAGE:reference.imageId,EXPERT_R_SANDBOX_WORK_ROOT:path.join(directory,'work'),...options.env};
  const admittedProvider=options.mutateDuringStage?{...provider,async openVerifiedRead(key,expected){const opened=await provider.openVerifiedRead(key,expected);await options.mutateDuringStage(provider,key);return opened;}}:provider;
  const runtime=createPrivateKernelRuntime({env,provider:options.provider||admittedProvider,environmentManifest:manifest,runProcessImpl:commands,spawnImpl,transportFactory,clock:()=>now,maxRetiredIds:options.maxRetiredIds,maxTombstones:options.maxTombstones});
  runtimes.push(runtime);
  const start=(id=kernelId,extra={})=>runtime.start({...scope,kernelId:id,environment:reference,inputs:[],...extra});
  const restart=()=>{const restarted=createPrivateKernelRuntime({env,provider,environmentManifest:manifest,runProcessImpl:commands,spawnImpl,transportFactory,clock:()=>now});runtimes.push(restarted);return restarted;};
  return{runtime,start,reference,directory,calls,containers,provider,transports,restart,requests:()=>requests,advance:ms=>now+=ms};
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
