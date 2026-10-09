import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
const {startKernelFixtureBroker}=require('./_privateKernelFixtures');
const {createArtifactVersionService}=require('./artifactVersions');
const db=require('./pgDatabase');
let broker,http,server,directory,provider,owner,analyst,project,savedEnv;
describe.skipIf(!process.env.DATABASE_URL)('authenticated private R interruption and restart receipts',()=>{
  beforeAll(async()=>{
    savedEnv={...process.env};directory=await mkdtemp(path.join(os.tmpdir(),'traceomics-controls-'));broker=await startKernelFixtureBroker();
    Object.assign(process.env,{STORAGE_ROOT:directory,APP_DEPLOYMENT_MODE:'private',EXPERT_R_ENABLED:'true',EXPERT_R_ACCESS_POLICY:'project-roles',EXPERT_R_SANDBOX_URL:broker.url,EXPERT_R_SANDBOX_TOKEN:broker.token});
    provider={...require('./storage').createLocalStorageProvider()};http=require('./_http-test-utils');server=await http.startServer();
  });
  beforeEach(async()=>{
    vi.restoreAllMocks();await db.resetSchemaForTests();broker.sessions.clear();broker.calls.length=0;for(const key of Object.keys(broker.hooks))delete broker.hooks[key];
    owner=await http.createUserWithToken({email:'control-owner@example.test'});analyst=await http.createUserWithToken({email:'control-analyst@example.test'});
    const organization=await db.createOrganizationForUser(owner.user.id,{name:'Kernel control lab'});project=await db.createProjectForUser(owner.user.id,{organizationId:organization.id,name:'Control study'});await db.addProjectMemberByEmail(project.id,analyst.user.email,'analyst',{userId:owner.user.id});
  });
  afterAll(async()=>{vi.restoreAllMocks();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(broker)await broker.close();await db.close();if(directory)await rm(directory,{recursive:true,force:true});for(const key of ['STORAGE_ROOT','APP_DEPLOYMENT_MODE','EXPERT_R_ENABLED','EXPERT_R_ACCESS_POLICY','EXPERT_R_SANDBOX_URL','EXPERT_R_SANDBOX_TOKEN']){if(savedEnv[key]===undefined)delete process.env[key];else process.env[key]=savedEnv[key];}});
  const request=(suffix='',options={})=>http.api(server,'/api/private-r-kernels/'+project.id+suffix,{token:owner.token,...options});
  const startInput=(inputs=[])=>({requestId:randomUUID(),workspaceId:'controls_workspace',environment:broker.reference,inputs});
  async function start(input=startInput()){const response=await request('',{method:'POST',body:input});expect(response.status).toBe(200);return response.data;}
  const command=(kernel,source,requestId=randomUUID())=>request('/'+kernel.id+'/executions',{method:'POST',body:{requestId,source}});
  const interrupt=(kernel,extra={})=>request('/'+kernel.id+'/interrupt',{method:'POST',body:{requestId:randomUUID(),generation:kernel.generation,...extra}});
  const restart=(kernel,body={requestId:randomUUID(),generation:kernel.generation})=>request('/'+kernel.id+'/restart',{method:'POST',body});
  async function pending(kernel) {let entered;const enteredPromise=new Promise(resolve=>{entered=resolve;});broker.hooks.beforeExecutePending=entered;const requestId=randomUUID(),response=command(kernel,'interrupt_fixture',requestId);await enteredPromise;return {requestId,response};}
  async function file(){const filename=path.join(directory,randomUUID()+'.csv');await writeFile(filename,'sample,condition\nS1,treated\n');return createArtifactVersionService(db,provider).importFile(owner.user.id,project.id,{path:filename,originalFilename:'samples.csv'});}

  it('interrupts an exact pending command through a concurrent control channel, retains source/order and permits the next command',async()=>{
    const kernel=await start(),running=await pending(kernel);
    const result=await interrupt(kernel,{executionRequestId:running.requestId});expect(result.status).toBe(200);expect(result.data).toMatchObject({outcome:'interrupted',idleConfirmed:true,session:{status:'ready'},execution:{status:'failed',source:'interrupt_fixture',order:1,result:{interrupted:true,error:{code:'PRIVATE_KERNEL_INTERRUPTED'}}}});
    expect((await running.response).data.id).toBe(result.data.execution.id);expect((await command(kernel,'n <- 8')).data.order).toBe(2);expect(broker.calls.filter(call=>call.path.endsWith('/execute'))).toHaveLength(2);
    const native=broker.calls.find(call=>call.path.endsWith('/interrupt')).input;expect(native).toMatchObject({executionId:result.data.execution.id,order:1,generation:kernel.generation});expect(native.source).toBeUndefined();
  });
  it('rejects a stale pending request, another creator and a changed generation before dispatching interrupt',async()=>{
    const kernel=await start(),first=(await command(kernel,'n <- 1')).data,running=await pending(kernel);
    expect((await interrupt(kernel,{executionId:first.id})).status).toBe(409);expect((await interrupt(kernel,{executionRequestId:randomUUID()})).status).toBe(409);expect((await interrupt(kernel,{generation:'f'.repeat(64)})).status).toBe(409);
    expect((await request('/'+kernel.id+'/interrupt',{token:analyst.token,method:'POST',body:{requestId:randomUUID(),generation:kernel.generation}})).status).toBe(404);expect(broker.calls.filter(call=>call.path.endsWith('/interrupt'))).toHaveLength(0);
    await interrupt(kernel,{executionRequestId:running.requestId});await running.response;
  });
  it('recognizes natural completion racing an interrupt without rewriting immutable scientific evidence',async()=>{
    const kernel=await start(),entry=(await command(kernel,'n <- 3')).data;const before=(await db.query('SELECT * FROM private_r_executions WHERE id=$1',[entry.id])).rows[0];
    const response=await interrupt(kernel,{executionId:entry.id});expect(response.data).toMatchObject({outcome:'already-completed',idleConfirmed:true,execution:{status:'completed',result:{stdout:'[1] 3\n'}}});expect((await db.query('SELECT * FROM private_r_executions WHERE id=$1',[entry.id])).rows[0]).toEqual(before);
  });
  it('keeps interruption independently unavailable in an older runtime while preserving commands and restart',async()=>{
    const kernel=await start();broker.hooks.interruptEnabled=false;const entry=(await command(kernel,'n <- 3')).data;expect((await interrupt(kernel,{executionId:entry.id})).data.code).toBe('PRIVATE_KERNEL_INTERRUPT_UNAVAILABLE');expect(broker.calls.filter(call=>call.path.endsWith('/interrupt'))).toHaveLength(0);expect((await restart(kernel)).data.status).toBe('completed');
  });
  it('declines malformed interrupt evidence and does not infer readiness from a signal response',async()=>{
    const kernel=await start(),entry=(await command(kernel,'n <- 3')).data;broker.hooks.beforeInterruptResponse=async(_session,response)=>{response.generation='f'.repeat(64);};
    const response=await interrupt(kernel,{executionId:entry.id});expect(response.status).toBe(502);expect(response.data.code).toBe('PRIVATE_KERNEL_RESPONSE_INVALID');expect((await db.query('SELECT status FROM private_r_executions WHERE id=$1',[entry.id])).rows[0].status).toBe('completed');
  });
  it('stops revoked access during interruption and returns no retained source or output to the revoked caller',async()=>{
    const kernel=await start(),running=await pending(kernel);broker.hooks.beforeInterruptResponse=async()=>{await db.query("INSERT INTO platform_capabilities(user_id,capability)VALUES($1,'expert_r.denied')",[owner.user.id]);};
    const response=await interrupt(kernel,{executionRequestId:running.requestId});expect(response.status).toBe(403);expect(JSON.stringify(response.data)).not.toMatch(/interrupt_fixture|source|stdout/);await running.response;expect(broker.sessions.get(kernel.id).status).toBe('stopped');
  });
  it('keeps an unconfirmed signal unknown until a separate exact terminal execution receipt arrives',async()=>{
    const kernel=await start();let release,entered;const enteredPromise=new Promise(resolve=>{entered=resolve;});broker.hooks.beforeExecuteResponse=async()=>{entered();await new Promise(resolve=>{release=resolve;});};
    const running=await pending(kernel);broker.hooks.beforeInterruptResponse=async(session,response)=>{session.status='unknown';response.status='unknown';response.outcome='unconfirmed';response.idleConfirmed=false;delete response.execution;};
    const response=await interrupt(kernel,{executionRequestId:running.requestId});await enteredPromise;expect(response.data).toMatchObject({outcome:'unconfirmed',idleConfirmed:false,session:{status:'unknown'},execution:{status:'unknown',completionKnown:false}});expect((await command(kernel,'n <- 10')).status).toBe(409);release();expect((await running.response).data).toMatchObject({status:'failed',result:{interrupted:true}});expect(broker.calls.filter(call=>call.path.endsWith('/execute'))).toHaveLength(1);
  });
  it('reconciles interrupted serialization through its failed publication receipt without publishing partial output',async()=>{
    const kernel=await start();let entered;const gate=new Promise(resolve=>{entered=resolve;});broker.hooks.beforeExportStorage=async session=>{entered();await new Promise(resolve=>{session.releaseExecution=resolve;});};
    const saving=request('/'+kernel.id+'/publications',{method:'POST',body:{requestId:randomUUID(),type:'object',binding:'obj',name:'Interrupted save'}});await gate;
    const active=(await request('/'+kernel.id)).data;const response=await interrupt(kernel,{executionId:active.activeExecutionId});expect(response.data).toMatchObject({outcome:'interrupted',session:{status:'ready'},execution:{status:'failed',result:{interrupted:true}}});expect((await saving).data).toMatchObject({publication:{status:'failed'},version:null});expect((await db.query('SELECT id FROM managed_artifact_versions WHERE project_id=$1',[project.id])).rows).toEqual([]);expect((await command(kernel,'n <- 12')).data.order).toBe(2);
  });
  it('restarts only from exact original input versions and pinned environment into a linked new identity without source replay',async()=>{
    const version=await file(),kernel=await start(startInput([version.reference]));await command(kernel,'n <- 23');const response=await restart(kernel);expect(response.status).toBe(200);expect(response.data).toMatchObject({status:'completed',previousKernelId:kernel.id,previousSession:{status:'stopped',memoryState:'lost'},replay:{performed:false,unsavedMemoryLost:true},session:{restartedFromKernelId:kernel.id,nextOrder:0,environment:kernel.environment,inputs:kernel.inputs}});
    expect(response.data.session.id).not.toBe(kernel.id);expect(response.data.session.generation).not.toBe(kernel.generation);expect(broker.sessions.get(response.data.session.id).n).toBe(0);expect(broker.calls.filter(call=>call.path.endsWith('/execute'))).toHaveLength(1);expect(JSON.stringify(response.data)).not.toMatch(/storage_key|internalStorageKey|Bearer/);
    const starts=broker.calls.filter(call=>call.path==='/kernels/start');expect(starts).toHaveLength(2);expect(starts[1].input.inputs).toEqual(starts[0].input.inputs);
  });
  it('reserves a single restart before delayed stop, fences commands and duplicate requests never create another kernel',async()=>{
    const kernel=await start();let release,entered;const gate=new Promise(resolve=>{entered=resolve;});broker.hooks.beforeStopResponse=async()=>{entered();await new Promise(resolve=>{release=resolve;});};
    const input={requestId:randomUUID(),generation:kernel.generation};const first=restart(kernel,input);await gate;const duplicate=await restart(kernel,input);expect(duplicate.data).toMatchObject({status:'stopping',session:null});expect((await command(kernel,'n <- 4')).status).toBe(409);expect((await restart(kernel)).status).toBe(409);release();const completed=await first;expect(completed.data.status).toBe('completed');expect((await restart(kernel,input)).data.replacementKernelId).toBe(completed.data.replacementKernelId);expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(2);
  });
  it('recovers a lost replacement startup response by inspection without redispatching start or scientific source',async()=>{
    const kernel=await start();const input={requestId:randomUUID(),generation:kernel.generation};let replacementId;
    broker.hooks.beforeStartResponse=async session=>{replacementId=session.kernelId;};
    const service=require('./privateKernelService').createPrivateKernelService(db,provider,{client:{...require('./privateKernelClient').createPrivateKernelClient({baseUrl:broker.url,token:broker.token}),start:async spec=>{await require('./privateKernelClient').createPrivateKernelClient({baseUrl:broker.url,token:broker.token}).start(spec);throw Object.assign(new Error('Lost response'),{code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN',status:503});}},getEnvironment:()=>broker.manifest});
    const first=await service.restart(owner.user.id,project.id,kernel.id,input);expect(first).toMatchObject({status:'completed',replacementKernelId:replacementId,session:{status:'ready'}});expect((await restart(kernel,input)).data.replacementKernelId).toBe(replacementId);expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(2);expect(broker.calls.filter(call=>call.path.endsWith('/execute'))).toHaveLength(0);
  });
  it('records unknown stop completion and never creates a replacement on retry or inspection',async()=>{
    const kernel=await start(),input={requestId:randomUUID(),generation:kernel.generation};broker.hooks.beforeStopResponse=async(_session,req)=>{req.socket.destroy();};
    const response=await restart(kernel,input);expect(response.data).toMatchObject({status:'unknown',session:null});expect((await request('/'+kernel.id)).data.restart).toMatchObject({requestId:input.requestId,status:'unknown',replacementKernelId:response.data.replacementKernelId});expect((await restart(kernel,input)).data.replacementKernelId).toBe(response.data.replacementKernelId);expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(1);expect((await db.query('SELECT id FROM private_r_kernels WHERE restarted_from_kernel_id=$1',[kernel.id])).rows).toEqual([]);
  });
  it('ends an abandoned unknown restart after exact old stop is confirmed and permits only a separate explicit new start',async()=>{
    const kernel=await start(),input={requestId:randomUUID(),generation:kernel.generation};broker.hooks.beforeStopResponse=async(_session,req)=>{req.socket.destroy();};
    const uncertain=await restart(kernel,input);expect(uncertain.data).toMatchObject({status:'unknown',session:null});expect((await db.query('SELECT id FROM private_r_kernels WHERE restarted_from_kernel_id=$1',[kernel.id])).rows).toEqual([]);
    delete broker.hooks.beforeStopResponse;expect((await request('/'+kernel.id+'/stop',{method:'POST',body:{}})).data.status).toBe('stopped');
    const recovered=await request('/'+kernel.id+'/restart');expect(recovered.data).toMatchObject({status:'failed',failureCode:'PRIVATE_KERNEL_RESTART_NOT_STARTED',session:null,previousSession:{status:'stopped',restart:{status:'failed'}},replay:{performed:false,unsavedMemoryLost:true}});expect((await restart(kernel,input)).data.status).toBe('failed');expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(1);
    const fresh=await start();expect(fresh.id).not.toBe(kernel.id);expect(fresh.id).not.toBe(uncertain.data.replacementKernelId);expect(fresh.restartedFromKernelId).toBeNull();expect(fresh.nextOrder).toBe(0);expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(2);expect((await db.query('SELECT id FROM private_r_kernels WHERE restarted_from_kernel_id=$1',[kernel.id])).rows).toEqual([]);
  });
  it('does not inspect or stop a newly reserved child before the one authorized start has been dispatched',async()=>{
    const kernel=await start(),input={requestId:randomUUID(),generation:kernel.generation};let entered,release;const gate=new Promise(resolve=>{entered=resolve;});const nativeClient=require('./privateKernelClient').createPrivateKernelClient({baseUrl:broker.url,token:broker.token});
    const service=require('./privateKernelService').createPrivateKernelService(db,provider,{client:{...nativeClient,start:async spec=>{entered(spec);await new Promise(resolve=>{release=resolve;});return nativeClient.start(spec);}},getEnvironment:()=>broker.manifest});
    const first=service.restart(owner.user.id,project.id,kernel.id,input);const spec=await gate;const duplicate=await restart(kernel,input);expect(duplicate.data).toMatchObject({status:'starting',replacementKernelId:spec.kernelId,session:{status:'starting'}});expect(broker.calls.some(call=>call.path==='/kernels/'+spec.kernelId+'/inspect'||call.path==='/kernels/'+spec.kernelId+'/stop')).toBe(false);expect((await request('/'+kernel.id+'/restart')).data.status).toBe('starting');release();expect((await first).status).toBe('completed');expect((await request('/'+kernel.id+'/restart')).data.status).toBe('completed');expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(2);
  });
  it('restarts a stopped known generation only after confirming old runtime cleanup and preserves its journal',async()=>{
    const kernel=await start(),entry=(await command(kernel,'n <- 42')).data;await request('/'+kernel.id+'/stop',{method:'POST',body:{}});const before=(await db.query('SELECT * FROM private_r_executions WHERE id=$1',[entry.id])).rows[0];
    const result=await restart(kernel);expect(result.data).toMatchObject({status:'completed',session:{nextOrder:0,restartedFromKernelId:kernel.id}});expect(broker.calls.filter(call=>call.path==='/kernels/'+kernel.id+'/stop')).toHaveLength(2);expect((await db.query('SELECT * FROM private_r_executions WHERE id=$1',[entry.id])).rows[0]).toEqual(before);
  });
  it('bounds abandoned pre-dispatch startup reservations, inspects their original identity and never creates another kernel',async()=>{
    const kernel=await start(),input={requestId:randomUUID(),generation:kernel.generation};let entered,release;const gate=new Promise(resolve=>{entered=resolve;});const nativeClient=require('./privateKernelClient').createPrivateKernelClient({baseUrl:broker.url,token:broker.token});
    const service=require('./privateKernelService').createPrivateKernelService(db,provider,{client:{...nativeClient,start:async spec=>{entered(spec);await new Promise(resolve=>{release=resolve;});return nativeClient.start(spec);}},getEnvironment:()=>broker.manifest});
    const first=service.restart(owner.user.id,project.id,kernel.id,input);const spec=await gate;
    expect((await request('/'+spec.kernelId)).data.status).toBe('starting');expect(broker.calls.some(call=>call.path==='/kernels/'+spec.kernelId+'/inspect')).toBe(false);
    const future=require('./privateKernelService').createPrivateKernelService(db,provider,{client:nativeClient,getEnvironment:()=>broker.manifest,now:()=>Date.now()+151000});const recovered=await future.restartStatus(owner.user.id,project.id,kernel.id);expect(recovered).toMatchObject({status:'failed',session:{status:'stopped'}});release();expect(await first).toMatchObject({status:'failed',session:{status:'stopped'}});expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(2);expect((await db.query('SELECT id FROM private_r_kernels WHERE restarted_from_kernel_id=$1',[kernel.id])).rows).toHaveLength(1);
  });
  it('holds a control reservation across an already-finished execution response so no later scientific command can be reserved',async()=>{
    const kernel=await start(),entry=(await command(kernel,'n <- 3')).data;let entered,release;const gate=new Promise(resolve=>{entered=resolve;});broker.hooks.beforeInterruptResponse=async()=>{entered();await new Promise(resolve=>{release=resolve;});};
    const interrupting=interrupt(kernel,{executionId:entry.id});await gate;broker.sessions.get(kernel.id).status='executing';expect((await request('/'+kernel.id)).data.status).toBe('running');expect((await command(kernel,'n <- 9')).status).toBe(409);expect((await interrupt(kernel,{executionId:entry.id})).data.code).toBe('PRIVATE_KERNEL_CONTROL_BUSY');broker.sessions.get(kernel.id).status='ready';release();expect((await interrupting).data.idleConfirmed).toBe(true);expect((await command(kernel,'n <- 9')).data.order).toBe(2);
  });
  it('recovers an orphan control reservation only from exact terminal evidence and a validated idle session',async()=>{
    const kernel=await start(),entry=(await command(kernel,'n <- 3')).data,controlId=randomUUID();await db.query("UPDATE private_r_kernels SET status='unknown',active_execution_id=$2,active_control_id=$3 WHERE id=$1",[kernel.id,entry.id,controlId]);
    broker.sessions.get(kernel.id).status='executing';expect((await request('/'+kernel.id)).data.status).toBe('running');expect((await db.query('SELECT active_control_id FROM private_r_kernels WHERE id=$1',[kernel.id])).rows[0].active_control_id).toBe(controlId);expect((await command(kernel,'n <- 9')).status).toBe(409);
    broker.sessions.get(kernel.id).status='ready';expect((await request('/'+kernel.id)).data.status).toBe('ready');expect((await db.query('SELECT active_control_id FROM private_r_kernels WHERE id=$1',[kernel.id])).rows[0].active_control_id).toBeNull();expect((await command(kernel,'n <- 9')).data.order).toBe(2);
  });
  it('does not invert an execution-finalizer lock when interrupt reservation races a natural completion',async()=>{
    const kernel=await start();let executeEntered,releaseExecute;const executeGate=new Promise(resolve=>{executeEntered=resolve;});broker.hooks.beforeExecuteResponse=async()=>{executeEntered();await new Promise(resolve=>{releaseExecute=resolve;});};
    const requestId=randomUUID(),executing=command(kernel,'n <- 31',requestId);await executeGate;const entry=(await db.query('SELECT * FROM private_r_executions WHERE kernel_id=$1',[kernel.id])).rows[0];
    const connection=await (await db.connect()).connect();let entered;const gate=new Promise(resolve=>{entered=resolve;});broker.hooks.beforeInterruptResponse=async()=>{entered();};let interrupting;
    try {
      await connection.query('BEGIN');await connection.query('SELECT id FROM private_r_executions WHERE id=$1 FOR UPDATE',[entry.id]);interrupting=interrupt(kernel,{executionRequestId:requestId});
      const dispatch=await Promise.race([gate.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),1500))]);expect(dispatch).toBe(true);
      await connection.query("UPDATE private_r_kernels SET status='ready' WHERE id=$1",[kernel.id]);await connection.query('COMMIT');expect((await interrupting).data).toMatchObject({outcome:'already-completed',idleConfirmed:true,execution:{status:'completed'}});
    } finally {await connection.query('ROLLBACK');connection.release();releaseExecute();}
    expect((await executing).data).toMatchObject({status:'completed',source:'n <- 31'});if(interrupting)await interrupting;
  });
  it('refuses corrupted original bytes before stopping memory and refuses changed environments without substituting versions',async()=>{
    const version=await file(),kernel=await start(startInput([version.reference]));const key=(await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1',[version.versionId])).rows[0].storage_key;await writeFile(provider.resolveKey(key),'sample,condition\nS2,changed\n');
    expect((await restart(kernel)).data.code).toBe('ARTIFACT_INTEGRITY_FAILED');expect(broker.sessions.get(kernel.id).status).toBe('ready');expect(broker.calls.filter(call=>call.path.endsWith('/stop'))).toHaveLength(0);expect((await db.query('SELECT id FROM private_r_kernel_restarts')).rows).toEqual([]);
    const service=require('./privateKernelService').createPrivateKernelService(db,provider,{getEnvironment:()=>({...broker.manifest,rVersion:'4.5.2'})});await expect(service.restart(owner.user.id,project.id,kernel.id,{requestId:randomUUID(),generation:kernel.generation})).rejects.toHaveProperty('code');expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(1);
  });
  it('rechecks current membership after stop and never admits a replacement if it was revoked while stopping',async()=>{
    const kernel=await start();broker.hooks.beforeStopResponse=async()=>{await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[project.id,owner.user.id]);};
    const result=await restart(kernel);expect(result.status).toBe(404);expect(JSON.stringify(result.data)).not.toMatch(/environment|inputs|kernelId/);expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(1);expect((await db.query('SELECT status FROM private_r_kernel_restarts')).rows[0].status).toBe('failed');
  });
  it('stops its exact live replacement on revoked access to the old creator-private restart receipt',async()=>{
    const kernel=await start(),restarted=(await restart(kernel)).data;await db.query("INSERT INTO platform_capabilities(user_id,capability)VALUES($1,'expert_r.denied')",[owner.user.id]);
    const result=await request('/'+kernel.id+'/restart');expect(result.status).toBe(403);expect(JSON.stringify(result.data)).not.toMatch(/environment|inputs|requestId/);expect(broker.sessions.get(restarted.session.id).status).toBe('stopped');
  });
  it('returns a failed recorded receipt after post-stop capacity admission fails so the caller sees lost memory',async()=>{
    const version=await file(),kernel=await start(startInput([version.reference]));const client=require('./privateKernelClient').createPrivateKernelClient({baseUrl:broker.url,token:broker.token});const service=require('./privateKernelService').createPrivateKernelService(db,provider,{client,getEnvironment:()=>broker.manifest});
    const original=provider.openVerifiedRead.bind(provider);let checks=0;
    vi.spyOn(provider,'openVerifiedRead').mockImplementation(async(...args)=>{const opened=await original(...args);checks++;if(checks===2)await service.start(owner.user.id,project.id,{...startInput(),workspaceId:'other_workspace'});return opened;});
    const result=await service.restart(owner.user.id,project.id,kernel.id,{requestId:randomUUID(),generation:kernel.generation});expect(result).toMatchObject({status:'failed',failureCode:'PRIVATE_KERNEL_LIMIT',previousSession:{status:'stopped',memoryState:'lost'},session:null,replay:{performed:false,unsavedMemoryLost:true}});expect((await db.query('SELECT id FROM private_r_kernels WHERE restarted_from_kernel_id=$1',[kernel.id])).rows).toEqual([]);expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(2);
  });
  it('protects restart receipts and parent links from changes and rejects request identifier reuse',async()=>{
    const input=startInput(),kernel=await start(input);expect((await restart(kernel,{requestId:input.requestId,generation:kernel.generation})).status).toBe(409);const result=await restart(kernel);expect(result.data.status).toBe('completed');
    await expect(db.query('UPDATE private_r_kernels SET restarted_from_kernel_id=NULL WHERE id=$1',[result.data.session.id])).rejects.toMatchObject({code:'55000'});await expect(db.query("UPDATE private_r_kernel_restarts SET replacement_kernel_id=$2 WHERE id=$1",[result.data.id,'pk_'+'f'.repeat(24)])).rejects.toMatchObject({code:'55000'});await expect(db.query("UPDATE private_r_kernel_restarts SET status='unknown' WHERE id=$1",[result.data.id])).rejects.toMatchObject({code:'55000'});
  });
});
