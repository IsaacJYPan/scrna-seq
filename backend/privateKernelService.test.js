import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
const {startKernelFixtureBroker}=require('./_privateKernelFixtures');
const {createPrivateKernelService}=require('./privateKernelService');
const {createArtifactVersionService}=require('./artifactVersions');
const {createPrivateKernelClient}=require('./privateKernelClient');
const db=require('./pgDatabase');
const configured=Boolean(process.env.DATABASE_URL);
let broker,http,server,directory,provider,owner,analyst,viewer,outsider,project,savedEnv;
describe.skipIf(!configured)('private R session service through authenticated HTTP/PostgreSQL/storage',()=>{
  beforeAll(async()=>{
    savedEnv={...process.env};directory=await mkdtemp(path.join(os.tmpdir(),'traceomics-kernels-'));broker=await startKernelFixtureBroker();
    Object.assign(process.env,{STORAGE_ROOT:directory,APP_DEPLOYMENT_MODE:'private',EXPERT_R_ENABLED:'true',EXPERT_R_ACCESS_POLICY:'project-roles',EXPERT_R_SANDBOX_URL:broker.url,EXPERT_R_SANDBOX_TOKEN:broker.token});
    provider={...require('./storage').createLocalStorageProvider()};http=require('./_http-test-utils');server=await http.startServer();
  });
  beforeEach(async()=>{
    vi.restoreAllMocks();await db.resetSchemaForTests();broker.sessions.clear();broker.calls.length=0;delete broker.hooks.beforeStartResponse;delete broker.hooks.beforeExecuteResponse;delete broker.hooks.beforeStopResponse;
    owner=await http.createUserWithToken({email:'kernel-owner@example.test'});analyst=await http.createUserWithToken({email:'kernel-analyst@example.test'});viewer=await http.createUserWithToken({email:'kernel-viewer@example.test'});outsider=await http.createUserWithToken({email:'kernel-outsider@example.test'});
    const organization=await db.createOrganizationForUser(owner.user.id,{name:'Private kernel lab'});project=await db.createProjectForUser(owner.user.id,{organizationId:organization.id,name:'Kernel study'});
    await db.addProjectMemberByEmail(project.id,analyst.user.email,'analyst',{userId:owner.user.id});await db.addProjectMemberByEmail(project.id,viewer.user.email,'viewer',{userId:owner.user.id});
  });
  afterAll(async()=>{vi.restoreAllMocks();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(broker)await broker.close();await db.close();if(directory)await rm(directory,{recursive:true,force:true});for(const key of ['STORAGE_ROOT','APP_DEPLOYMENT_MODE','EXPERT_R_ENABLED','EXPERT_R_ACCESS_POLICY','EXPERT_R_SANDBOX_URL','EXPERT_R_SANDBOX_TOKEN']){if(savedEnv[key]===undefined)delete process.env[key];else process.env[key]=savedEnv[key];}});
  const base=()=>'/api/private-r-kernels/'+project.id;
  const request=(suffix='',options={})=>http.api(server,base()+suffix,{token:owner.token,...options});
  const startInput=()=>({requestId:randomUUID(),workspaceId:'workspace_one',environment:broker.reference,inputs:[]});
  async function start(input=startInput(),token=owner.token){const response=await request('',{token,method:'POST',body:input});expect(response.status).toBe(200);return response.data;}
  const command=(kernel,source,requestId=randomUUID())=>request('/'+kernel.id+'/executions',{method:'POST',body:{requestId,source}});
  async function file(name='samples.csv',bytes='sample,condition\nS1,treated\n'){const filename=path.join(directory,name);await writeFile(filename,bytes);return createArtifactVersionService(db,provider).importFile(owner.user.id,project.id,{path:filename,originalFilename:name});}

  it('requires authenticated current writers and never exposes another creator’s session or journal',async()=>{
    expect((await request('',{token:null})).status).toBe(401);expect((await request('',{token:outsider.token})).status).toBe(404);expect((await request('',{token:viewer.token})).status).toBe(403);
    const kernel=await start();const entry=await command(kernel,'n <- 3');expect(entry.status).toBe(200);
    expect((await request('/'+kernel.id,{token:analyst.token})).status).toBe(404);expect((await request('/'+kernel.id+'/executions/'+entry.data.id,{token:analyst.token})).status).toBe(404);
    expect((await request('',{token:analyst.token})).data.items).toEqual([]);
  });
  it('pins the actual environment and generation, preserves exact start idempotence, and rejects changed settings',async()=>{
    const input=startInput();const kernel=await start(input);const repeated=await start(input);expect(repeated.id).toBe(kernel.id);expect(kernel.generation).toMatch(/^[a-f0-9]{64}$/);expect(kernel.environment).toEqual(broker.reference);
    expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(1);
    expect((await request('',{method:'POST',body:{...input,workspaceId:'different_workspace'}})).status).toBe(409);
    expect(JSON.stringify(kernel)).not.toMatch(/internalStorageKey|storage_key|Bearer|containerName/);
    expect((await request('',{method:'POST',body:{...startInput(),environment:{...broker.reference,rVersion:'4.5.2'}}})).status).toBe(409);
  });
  it('verifies exact selected input bytes before runtime admission and never returns private storage keys',async()=>{
    const version=await file();const kernel=await start({...startInput(),inputs:[version.reference]});expect(kernel.inputs[0].reference).toEqual(version.reference);
    const native=broker.calls.find(call=>call.path==='/kernels/start').input.inputs[0];expect(native).toMatchObject({checksumSha256:version.sha256,format:'csv',role:'input'});expect(native.internalStorageKey).toBeTruthy();expect(JSON.stringify(kernel)).not.toContain(native.internalStorageKey);
    await request('/'+kernel.id+'/stop',{method:'POST',body:{}});const row=(await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1',[version.versionId])).rows[0];await writeFile(provider.resolveKey(row.storage_key),'sample,condition\nS2,changed\n');
    const failed=await request('',{method:'POST',body:{...startInput(),inputs:[version.reference]}});expect(failed.status).toBe(409);expect(failed.data.code).toBe('ARTIFACT_INTEGRITY_FAILED');expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(1);
  });
  it('rechecks membership after checksum verification and declines admission if it was revoked',async()=>{
    const version=await file();const original=provider.openVerifiedRead.bind(provider);vi.spyOn(provider,'openVerifiedRead').mockImplementationOnce(async(...args)=>{const opened=await original(...args);await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[project.id,owner.user.id]);return opened;});
    const service=createPrivateKernelService(db,provider,{client:createPrivateKernelClient({baseUrl:broker.url,token:broker.token}),getEnvironment:()=>broker.manifest});await expect(service.start(owner.user.id,project.id,{...startInput(),inputs:[version.reference]})).rejects.toMatchObject({code:'NOT_FOUND'});expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(0);
  });
  it('reserves immutable source and increasing command order before dispatch, and duplicate requests never rerun',async()=>{
    const kernel=await start();const requestId=randomUUID();const first=await command(kernel,'n <- 3',requestId);expect(first.data).toMatchObject({order:1,status:'completed',source:'n <- 3',completionKnown:true,result:{stdout:'[1] 3\n'}});
    const second=await command(kernel,'n + 1');expect(second.data).toMatchObject({order:2,result:{stdout:'[1] 4\n'}});expect((await command(kernel,'n <- 3',requestId)).data.id).toBe(first.data.id);expect(broker.calls.filter(call=>call.path.endsWith('/execute'))).toHaveLength(2);
    expect((await command(kernel,'n <- 8',requestId)).status).toBe(409);await expect(db.query('UPDATE private_r_executions SET source_code=$2 WHERE id=$1',[first.data.id,'altered'])).rejects.toThrow();await expect(db.query("UPDATE private_r_executions SET result_json='{}' WHERE id=$1",[first.data.id])).rejects.toThrow();
    const journal=await request('/'+kernel.id+'/executions');expect(journal.data.items.map(entry=>entry.order)).toEqual([2,1]);expect(journal.data.items[0].source).toBeUndefined();
  });
  it('serializes concurrent scientific commands and retains bounded safe tables, PNG, warnings, and failed source',async()=>{
    const kernel=await start();const pending=command(kernel,'delay_fixture');await new Promise(resolve=>setTimeout(resolve,30));expect((await command(kernel,'n <- 9')).status).toBe(409);expect((await pending).status).toBe(200);
    const rich=await command(kernel,'data.frame(cells=n); plot(n); warning("inspect")');expect(rich.data.result).toMatchObject({tables:[{columns:['cells','condition']}],figures:[{mimeType:'image/png',width:1,height:1}],warnings:['Fixture warning']});
    const failed=await command(kernel,'stop("inspect failure")');expect(failed.data).toMatchObject({status:'failed',source:'stop("inspect failure")',result:{error:{message:'Fixture R error'}}});
  });
  it('marks disconnected completion unknown without resubmission and blocks later commands until a new session',async()=>{
    const kernel=await start();const requestId=randomUUID();const disconnected=await command(kernel,'disconnect_fixture',requestId);expect(disconnected.status).toBe(503);expect(disconnected.data.code).toBe('PRIVATE_KERNEL_TRANSPORT_UNKNOWN');
    const repeated=await command(kernel,'disconnect_fixture',requestId);expect(repeated.data).toMatchObject({status:'unknown',completionKnown:false,source:'disconnect_fixture'});expect((await command(kernel,'n <- 9')).status).toBe(409);expect(broker.calls.filter(call=>call.path.endsWith('/execute'))).toHaveLength(1);
    expect((await request('/'+kernel.id)).data.status).toBe('unknown');const stopped=await request('/'+kernel.id+'/stop',{method:'POST',body:{}});expect(stopped.data.memoryState).toBe('lost');const fresh=await start();expect(fresh.id).not.toBe(kernel.id);expect(fresh.generation).not.toBe(kernel.generation);
  });
  it('reconciles a confirmed runtime completion from inspection without rerunning a journal command',async()=>{
    const kernel=await start();const entry=await command(kernel,'n <- 3');await db.query("UPDATE private_r_kernels SET status='unknown',active_execution_id=$2 WHERE id=$1",[kernel.id,entry.data.id]);
    expect((await request('/'+kernel.id)).data.status).toBe('ready');expect(broker.calls.filter(call=>call.path.endsWith('/execute'))).toHaveLength(1);
  });
  it('expires owned runtime memory and treats a changed generation as unknown rather than substituting state',async()=>{
    const kernel=await start();broker.sessions.get(kernel.id).generation='f'.repeat(64);expect((await request('/'+kernel.id)).data.status).toBe('unknown');expect((await command(kernel,'n')).status).toBe(409);
    broker.sessions.get(kernel.id).generation=kernel.generation;await db.query("UPDATE private_r_kernels SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[kernel.id]);expect((await request('/'+kernel.id)).data).toMatchObject({status:'stopped',memoryState:'lost'});expect(broker.sessions.get(kernel.id).status).toBe('stopped');
  });
  it('enforces per-owner/global active quotas before runtime creation',async()=>{
    const kernel=await start();expect((await request('',{method:'POST',body:{...startInput(),workspaceId:'second'}})).status).toBe(429);await start(startInput(),analyst.token);
    await db.addProjectMemberByEmail(project.id,outsider.user.email,'analyst',{userId:owner.user.id});expect((await request('',{token:outsider.token,method:'POST',body:startInput()})).status).toBe(429);expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(2);
    await request('/'+kernel.id+'/stop',{method:'POST',body:{}});expect((await request('',{token:outsider.token,method:'POST',body:startInput()})).status).toBe(200);
  });
  it('stops revoked execution access before returning any prior source or output, while read-only owner history remains private',async()=>{
    const kernel=await start();const entry=await command(kernel,'n <- 3');await db.query("INSERT INTO platform_capabilities(user_id,capability)VALUES($1,'expert_r.denied')",[owner.user.id]);
    const denied=await request('/'+kernel.id+'/executions/'+entry.data.id);expect(denied.status).toBe(403);expect(JSON.stringify(denied.data)).not.toContain('n <- 3');expect(broker.sessions.get(kernel.id).status).toBe('stopped');
    const history=await http.api(server,'/api/execution-history/'+project.id+'/'+entry.data.id,{token:owner.token});expect(history.status).toBe(200);expect(history.data).toMatchObject({kind:'r-console',source:{code:'n <- 3'},kernel:{generation:kernel.generation,order:1},replay:{complete:false}});
    expect((await http.api(server,'/api/execution-history/'+project.id+'/'+entry.data.id,{token:analyst.token})).status).toBe(404);expect((await http.api(server,'/api/execution-history/'+project.id+'/'+entry.data.id+'/environment',{token:owner.token})).data).toMatchObject({reference:broker.reference,integrityVerified:true});
  });
  it('bounds source/body/pagination and rejects malformed requests before creating a kernel or command',async()=>{
    const kernel=await start();expect((await command(kernel,'x'.repeat(32769))).status).toBe(400);expect((await request('/'+kernel.id+'/executions?limit=31')).status).toBe(400);
    const malformed=await fetch('http://127.0.0.1:'+server.address().port+base(),{method:'POST',headers:{Cookie:require('./config').sessionCookieName()+'='+owner.token,Origin:'http://localhost:5173','Content-Type':'application/json'},body:'{'});expect(malformed.status).toBe(400);
    const huge=await request('',{method:'POST',body:{source:'x'.repeat(85000)}});expect(huge.status).toBe(413);expect(broker.calls.filter(call=>call.path.endsWith('/execute'))).toHaveLength(0);
  });
  it('retains a real completed receipt privately if execution access is revoked during the upstream response',async()=>{
    const kernel=await start();broker.hooks.beforeExecuteResponse=async()=>{await db.query("INSERT INTO platform_capabilities(user_id,capability)VALUES($1,'expert_r.denied')",[owner.user.id]);};
    const response=await command(kernel,'n <- 7');expect(response.status).toBe(403);expect(JSON.stringify(response.data)).not.toMatch(/n <- 7|\[1\] 7/);expect(broker.sessions.get(kernel.id).status).toBe('stopped');
    const entry=(await db.query('SELECT * FROM private_r_executions WHERE kernel_id=$1',[kernel.id])).rows[0];expect(entry.status).toBe('completed');expect(entry.result_json.stdout).toBe('[1] 7\n');
  });
  it('does not resurrect a stopped session when a delayed startup response arrives',async()=>{
    let release,started;const dispatched=new Promise(resolve=>{started=resolve;});broker.hooks.beforeStartResponse=async session=>{started(session);await new Promise(resolve=>{release=resolve;});};
    const pending=request('',{method:'POST',body:startInput()});const native=await dispatched;const stopped=await request('/'+native.kernelId+'/stop',{method:'POST',body:{}});expect(stopped.data.status).toBe('stopped');release();expect((await pending).data.status).toBe('stopped');expect((await request('/'+native.kernelId)).data.status).toBe('stopped');expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(1);
  });
  it('finalizes restored session metadata as stopped and pending command completion as unknown without changing immutable completed receipts',async()=>{
    const kernel=await start();const completed=(await command(kernel,'n <- 3')).data;
    const {digest}=require('./privateKernelContract');const executionId='pex_'+'d'.repeat(24);
    await db.query(`INSERT INTO private_r_executions(id,kernel_id,project_id,owner_user_id,request_id,kernel_generation,execution_order,status,source_code,source_sha256,started_at) VALUES($1,$2,$3,$4,$5,$6,2,'running','n + 1',$7,NOW())`,[executionId,kernel.id,project.id,owner.user.id,randomUUID(),kernel.generation,digest('n + 1')]);await db.query("UPDATE private_r_kernels SET status='running',next_order=2,active_execution_id=$2 WHERE id=$1",[kernel.id,executionId]);
    const before=(await db.query('SELECT * FROM private_r_executions WHERE id=$1',[completed.id])).rows[0];
    const finalized=await require('../scripts/restore-runtime').finalizeRestoredSecurityState({connectionString:process.env.DATABASE_URL});expect(finalized).toMatchObject({stoppedKernels:1,unknownExecutions:1});
    expect((await db.query('SELECT * FROM private_r_executions WHERE id=$1',[completed.id])).rows[0]).toEqual(before);expect((await db.query('SELECT status,result_json,source_code,completed_at FROM private_r_executions WHERE id=$1',[executionId])).rows[0]).toEqual({status:'unknown',result_json:null,source_code:'n + 1',completed_at:null});
    expect((await request('/'+kernel.id)).data).toMatchObject({status:'stopped',activeExecutionId:null,memoryState:'lost'});expect((await command(kernel,'n')).status).toBe(409);expect(broker.calls.filter(call=>call.path.endsWith('/execute'))).toHaveLength(1);
  });
  it('keeps a confirmed stop when another overlapping stop loses its transport response',async()=>{
    const kernel=await start();let release,entered;const firstEntered=new Promise(resolve=>{entered=resolve;});let calls=0;
    broker.hooks.beforeStopResponse=async(_session,request)=>{calls++;if(calls===1){entered();await new Promise(resolve=>{release=resolve;});request.socket.destroy();}};
    const first=request('/'+kernel.id+'/stop',{method:'POST',body:{}});await firstEntered;const second=await request('/'+kernel.id+'/stop',{method:'POST',body:{}});expect(second.data.status).toBe('stopped');release();expect((await first).data.status).toBe('stopped');expect((await request('/'+kernel.id)).data.memoryState).toBe('lost');
  });
  it('retains the executing service/resource identity when a later stopped-kernel inspection comes from a new broker process',async()=>{
    const kernel=await start();const entry=(await command(kernel,'n <- 3')).data;const generation=broker.target.generation,cpu=broker.resources.cpuLimit;
    try {broker.target.generation='e'.repeat(64);broker.resources.cpuLimit=2;broker.sessions.get(kernel.id).status='stopped';const stopped=await request('/'+kernel.id);expect(stopped.data.target.generation).toBe(generation);expect(stopped.data.resources.cpuLimit).toBe(cpu);const history=await http.api(server,'/api/execution-history/'+project.id+'/'+entry.id,{token:owner.token});expect(history.data.target.generation).toBe(generation);} finally {broker.target.generation=generation;broker.resources.cpuLimit=cpu;}
  });
});
