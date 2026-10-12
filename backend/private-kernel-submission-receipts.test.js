import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
const {startKernelFixtureBroker}=require('./_privateKernelFixtures');
const {createPrivateKernelService}=require('./privateKernelService');
const c=require('./privateKernelContract');
const db=require('./pgDatabase');
let broker,http,server,directory,owner,analyst,viewer,outsider,project,otherProject,savedEnv;
const environmentKeys=['STORAGE_ROOT','APP_DEPLOYMENT_MODE','EXPERT_R_ENABLED','EXPERT_R_ACCESS_POLICY','EXPERT_R_SANDBOX_URL','EXPERT_R_SANDBOX_TOKEN'];
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
describe.skipIf(!process.env.DATABASE_URL)('exact owner-private R submission identities through HTTP and PostgreSQL',()=>{
  beforeAll(async()=>{
    savedEnv={...process.env};directory=await mkdtemp(path.join(os.tmpdir(),'traceomics-private-receipts-'));broker=await startKernelFixtureBroker();
    Object.assign(process.env,{STORAGE_ROOT:directory,APP_DEPLOYMENT_MODE:'private',EXPERT_R_ENABLED:'true',EXPERT_R_ACCESS_POLICY:'project-roles',EXPERT_R_SANDBOX_URL:broker.url,EXPERT_R_SANDBOX_TOKEN:broker.token});
    http=require('./_http-test-utils');server=await http.startServer();
  });
  beforeEach(async()=>{
    vi.restoreAllMocks();await db.resetSchemaForTests();broker.sessions.clear();broker.calls.length=0;for(const key of Object.keys(broker.hooks))delete broker.hooks[key];
    owner=await http.createUserWithToken({email:'receipt-owner@example.test'});analyst=await http.createUserWithToken({email:'receipt-analyst@example.test'});
    viewer=await http.createUserWithToken({email:'receipt-viewer@example.test'});outsider=await http.createUserWithToken({email:'receipt-outsider@example.test'});
    const organization=await db.createOrganizationForUser(owner.user.id,{name:'Receipt lab'});project=await db.createProjectForUser(owner.user.id,{organizationId:organization.id,name:'Private receipt study'});
    otherProject=await db.createProjectForUser(owner.user.id,{organizationId:organization.id,name:'Other receipt study'});
    await db.addProjectMemberByEmail(project.id,analyst.user.email,'analyst',{userId:owner.user.id});await db.addProjectMemberByEmail(project.id,viewer.user.email,'viewer',{userId:owner.user.id});
  });
  afterAll(async()=>{vi.restoreAllMocks();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(broker)await broker.close();await db.close();if(directory)await rm(directory,{recursive:true,force:true});for(const key of environmentKeys){if(savedEnv[key]===undefined)delete process.env[key];else process.env[key]=savedEnv[key];}});
  const request=(suffix='',options={})=>http.api(server,'/api/private-r-kernels/'+project.id+suffix,{token:owner.token,...options});
  const input=()=>({requestId:randomUUID(),workspaceId:'receipt_workspace',environment:broker.reference,inputs:[]});
  async function start(value=input()){const response=await request('',{method:'POST',body:value});expect(response.status).toBe(200);return response.data;}
  const run=(kernel,source='n <- 3',requestId=randomUUID())=>request('/'+kernel.id+'/executions',{method:'POST',body:{requestId,source}});
  const save=(kernel,body={requestId:randomUUID(),name:'Private saved output',type:'object',binding:'n'})=>request('/'+kernel.id+'/publications',{method:'POST',body});
  const restart=(kernel,body={requestId:randomUUID(),generation:kernel.generation})=>request('/'+kernel.id+'/restart',{method:'POST',body});
  const suffix=receipt=>receipt.kind==='start'||receipt.kind==='restart'?'/'+receipt.kind+'-submissions/'+receipt.requestId:'/'+receipt.kernelId+'/'+receipt.kind+'-submissions/'+receipt.requestId;
  async function allReceipts(){const kernel=await start();const execution=await run(kernel);const publication=await save(kernel);const replacement=await restart(kernel);for(const response of [execution,publication,replacement])expect(response.status).toBe(200);return {kernel,receipts:[kernel.submission,execution.data.submission,publication.data.submission,replacement.data.submission],execution,publication,replacement};}
  async function snapshot(){const entries=await Promise.all(['private_r_kernels','private_r_executions','private_r_publications','private_r_kernel_restarts','managed_artifact_versions'].map(table=>db.query('SELECT * FROM '+table+' ORDER BY id')));return entries.map(entry=>entry.rows);}

  it('returns the original UUID/hash and exact identity for all four POST kinds and their GET counterparts',async()=>{
    const f=await allReceipts();
    for(const receipt of f.receipts){const response=await request(suffix(receipt));expect(response.status).toBe(200);expect(response.res.headers.get('cache-control')).toBe('private, no-store');expect(response.data).toMatchObject({kind:receipt.kind,requestId:receipt.requestId,requestHash:receipt.requestHash,kernelId:receipt.kernelId,generation:receipt.generation,status:receipt.kind==='start'?'stopped':receipt.status});if(receipt.kind!=='start')expect(response.data).toEqual(receipt);expect(response.data.schema).toBe('traceomics.private-r-submission.v1');expect(response.data.requestHash).toMatch(c.HASH);expect(Buffer.byteLength(JSON.stringify(response.data))).toBeLessThan(16384);}
    expect(f.receipts[1]).toMatchObject({kind:'execution',executionId:f.execution.data.id,order:1,requestHash:c.digest('n <- 3')});
    expect(f.receipts[2]).toMatchObject({kind:'publication',publicationId:f.publication.data.publication.id,sourceExecutionId:f.publication.data.publication.sourceExecutionId,order:2,versionId:f.publication.data.version.versionId});
    expect(f.receipts[3]).toMatchObject({kind:'restart',restartId:f.replacement.data.id,kernelId:f.kernel.id,generation:f.kernel.generation,replacementKernelId:f.replacement.data.session.id,status:'completed',completionKnown:true});
    expect(f.execution.data.requestId).toBe(f.receipts[1].requestId);expect(f.publication.data.publication.requestId).toBe(f.receipts[2].requestId);
  });
  it('preserves exact same-input POST receipts without another start, command, save, or restart',async()=>{
    const startBody=input(),kernel=await start(startBody);expect((await start(startBody)).submission).toMatchObject({kind:'start',requestId:startBody.requestId,kernelId:kernel.id,requestHash:kernel.submission.requestHash,generation:kernel.generation});
    const commandBody={requestId:randomUUID(),source:'n <- 3'},command=await request('/'+kernel.id+'/executions',{method:'POST',body:commandBody});
    expect((await request('/'+kernel.id+'/executions',{method:'POST',body:commandBody})).data.submission).toEqual(command.data.submission);
    const saveBody={requestId:randomUUID(),name:'Private output',type:'object',binding:'n'},publication=await save(kernel,saveBody);expect((await save(kernel,saveBody)).data.submission).toEqual(publication.data.submission);
    const restartBody={requestId:randomUUID(),generation:kernel.generation},replacement=await restart(kernel,restartBody);expect((await restart(kernel,restartBody)).data.submission).toEqual(replacement.data.submission);
    expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(2);expect(broker.calls.filter(call=>call.path.endsWith('/execute'))).toHaveLength(1);expect(broker.calls.filter(call=>call.path.endsWith('/export'))).toHaveLength(1);
  });
  it('binds changed start, source, save settings, and restart generation to conflicts without altering the original identities',async()=>{
    const startBody=input(),kernel=await start(startBody),requestId=randomUUID(),execution=await run(kernel,'n <- 3',requestId),saveBody={requestId:randomUUID(),name:'Private output',type:'object',binding:'n'},publication=await save(kernel,saveBody);
    expect((await request('',{method:'POST',body:{...startBody,workspaceId:'changed_workspace'}})).status).toBe(409);
    expect((await run(kernel,'n <- 8',requestId)).status).toBe(409);expect((await save(kernel,{...saveBody,binding:'changed_binding'})).status).toBe(409);
    const restartBody={requestId:randomUUID(),generation:kernel.generation},replacement=await restart(kernel,restartBody);expect((await restart(kernel,{...restartBody,generation:'f'.repeat(64)})).status).toBe(409);
    for(const receipt of [execution.data.submission,publication.data.submission,replacement.data.submission])expect((await request(suffix(receipt))).data).toEqual(receipt);
    expect(broker.calls.filter(call=>call.path==='/kernels/start')).toHaveLength(2);expect(broker.calls.filter(call=>call.path.endsWith('/execute'))).toHaveLength(1);expect(broker.calls.filter(call=>call.path.endsWith('/export'))).toHaveLength(1);
  });
  it('returns one original admission identity to competing identical command POSTs while its first response is pending',async()=>{
    const kernel=await start(),entered=deferred(),release=deferred(),requestId=randomUUID();broker.hooks.beforeExecuteResponse=async()=>{entered.resolve();await release.promise;};const first=run(kernel,'n <- 3',requestId);await entered.promise;
    try{const responses=await Promise.all(Array.from({length:8},()=>run(kernel,'n <- 3',requestId)));expect(responses.every(response=>response.status===200)).toBe(true);const receipts=responses.map(response=>response.data.submission);expect(new Set(receipts.map(receipt=>receipt.executionId)).size).toBe(1);for(const receipt of receipts)expect(receipt).toMatchObject({requestId,requestHash:c.digest('n <- 3'),order:1,status:'running',completionKnown:false});expect((await db.query('SELECT id FROM private_r_executions')).rows).toHaveLength(1);expect(broker.calls.filter(call=>call.path.endsWith('/execute'))).toHaveLength(1);}finally{release.resolve();await first;}
  });
  it('retains the exact uncertain command admission after a lost broker response and later stop',async()=>{
    const kernel=await start(),requestId=randomUUID(),lost=await run(kernel,'disconnect_fixture',requestId);expect(lost.status).toBe(503);
    const prior=await request('/'+kernel.id+'/execution-submissions/'+requestId);expect(prior.data).toMatchObject({kind:'execution',requestId,requestHash:c.digest('disconnect_fixture'),status:'unknown',completionKnown:false,order:1,completedAt:null});
    await request('/'+kernel.id+'/stop',{method:'POST',body:{}});const calls=broker.calls.length;expect((await request('/'+kernel.id+'/execution-submissions/'+requestId)).data).toEqual(prior.data);expect(broker.calls).toHaveLength(calls);
  });
  it('does not mistake a restart replacement using the same UUID for a normal start',async()=>{
    const f=await allReceipts();const receipt=f.receipts[3];expect((await request('/start-submissions/'+receipt.requestId)).status).toBe(404);
    expect((await request('/restart-submissions/'+receipt.requestId)).data).toMatchObject({kind:'restart',kernelId:f.kernel.id,replacementKernelId:f.replacement.data.session.id});
  });
  it('returns the original command and save after newer work and confirmed stop without consulting the broker',async()=>{
    const kernel=await start(),first=await run(kernel),firstSave=await save(kernel);await run(kernel,'n <- 8');await save(kernel);
    await request('/'+kernel.id+'/stop',{method:'POST',body:{}});const before=await snapshot(),calls=broker.calls.length;
    expect((await request(suffix(first.data.submission))).data).toEqual(first.data.submission);expect((await request(suffix(firstSave.data.submission))).data).toEqual(firstSave.data.submission);
    expect(await snapshot()).toEqual(before);expect(broker.calls).toHaveLength(calls);
  });
  it('reads all durable receipts with the broker unavailable and never inspects, starts, executes, serializes, or stops R',async()=>{
    const f=await allReceipts();const unavailable=async()=>{throw new Error('broker offline');};const calls={start:vi.fn(unavailable),inspect:vi.fn(unavailable),execute:vi.fn(unavailable),export:vi.fn(unavailable),exportStatus:vi.fn(unavailable),stop:vi.fn(unavailable)};
    const service=createPrivateKernelService(db,undefined,{client:calls,getEnvironment:vi.fn(unavailable),probeCapabilities:vi.fn(unavailable)}),before=await snapshot();
    for(const receipt of f.receipts)expect(await service.submission(receipt.kind,owner.user.id,project.id,receipt.requestId,receipt.kernelId)).toMatchObject({requestId:receipt.requestId,requestHash:receipt.requestHash,kernelId:receipt.kernelId});
    for(const method of Object.values(calls))expect(method).not.toHaveBeenCalled();expect(await snapshot()).toEqual(before);
  });
  it('retains owner-only metadata after execution capability denial and owner role downgrade to viewer',async()=>{
    const f=await allReceipts();await db.query("INSERT INTO platform_capabilities(user_id,capability)VALUES($1,'expert_r.denied')",[owner.user.id]);await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project.id,owner.user.id]);const before=await snapshot(),calls=broker.calls.length;
    for(const receipt of f.receipts)expect((await request(suffix(receipt))).status).toBe(200);
    expect(await snapshot()).toEqual(before);expect(broker.calls).toHaveLength(calls);expect((await run(f.replacement.data.session)).status).toBe(403);
  });
  it('keeps another creator’s receipts private from analysts, viewers, admins, outsiders, and the wrong project',async()=>{
    const f=await allReceipts();await db.query("UPDATE project_members SET role='admin' WHERE project_id=$1 AND user_id=$2",[project.id,analyst.user.id]);
    for(const receipt of f.receipts){for(const token of [analyst.token,viewer.token,outsider.token])expect((await request(suffix(receipt),{token})).status).toBe(404);expect((await http.api(server,'/api/private-r-kernels/'+otherProject.id+suffix(receipt),{token:owner.token})).status).toBe(404);expect((await request(suffix(receipt),{token:null})).status).toBe(401);}
  });
  it('does not substitute another kernel or a latest record for an unrecognized command/save UUID',async()=>{
    const f=await allReceipts(),replacement=f.replacement.data.session;
    for(const receipt of [f.receipts[1],f.receipts[2]]){expect((await request('/'+replacement.id+'/'+receipt.kind+'-submissions/'+receipt.requestId)).status).toBe(404);expect((await request('/'+receipt.kernelId+'/'+receipt.kind+'-submissions/'+randomUUID())).status).toBe(404);}
    expect((await request('/start-submissions/'+randomUUID())).status).toBe(404);expect((await request('/restart-submissions/'+randomUUID())).status).toBe(404);
  });
  it('bounds malformed identifiers before PostgreSQL UUID conversion and keeps errors private',async()=>{
    const kernel=await start();for(const kind of ['start','execution','publication','restart']){const prefix=kind==='start'||kind==='restart'?'/':'/'+kernel.id+'/';for(const malformed of ['bad','x'.repeat(2000),'00000000-0000-7000-8000-000000000000']){const response=await request(prefix+kind+'-submissions/'+malformed);expect(response.status).toBe(400);expect(response.data.code).toBe('PRIVATE_KERNEL_REQUEST_INVALID');expect(JSON.stringify(response.data)).not.toMatch(/SELECT|invalid input syntax|source|token/);}}
    expect((await request('/invalid-kernel/execution-submissions/'+randomUUID())).status).toBe(404);
  });
  it('reports accepted-but-starting honestly while the original POST is awaiting its runtime acknowledgement',async()=>{
    const entered=deferred(),release=deferred(),body=input();broker.hooks.beforeStartResponse=async()=>{entered.resolve();await release.promise;};const pending=request('',{method:'POST',body});await entered.promise;
    try{const calls=broker.calls.length,response=await request('/start-submissions/'+body.requestId);expect(response.status).toBe(200);expect(response.data).toMatchObject({kind:'start',status:'starting',generation:null,completionKnown:false,requestHash:c.digest({requestId:body.requestId,workspaceId:body.workspaceId,analysisObjectId:null,environment:body.environment,inputs:[]})});expect(broker.calls).toHaveLength(calls);}finally{release.resolve();await pending;}
  });
  it('reports the exact running command even when the runtime finished but its response is still pending',async()=>{
    const kernel=await start(),entered=deferred(),release=deferred(),requestId=randomUUID();broker.hooks.beforeExecuteResponse=async()=>{entered.resolve();await release.promise;};const pending=run(kernel,'n <- 3',requestId);await entered.promise;
    try{const calls=broker.calls.length,response=await request('/'+kernel.id+'/execution-submissions/'+requestId);expect(response.data).toMatchObject({kind:'execution',status:'running',generation:kernel.generation,order:1,completionKnown:false,completedAt:null,requestHash:c.digest('n <- 3')});expect(broker.calls).toHaveLength(calls);}finally{release.resolve();await pending;}
  });
  it('keeps the exact publication accepted-but-unverified without presenting a reserved version as saved',async()=>{
    const kernel=await start(),entered=deferred(),release=deferred(),body={requestId:randomUUID(),name:' Saved research output ',type:'object',binding:'n'};broker.hooks.beforeExportResponse=async()=>{entered.resolve();await release.promise;};const pending=save(kernel,body);await entered.promise;
    try{const calls=broker.calls.length,response=await request('/'+kernel.id+'/publication-submissions/'+body.requestId);expect(response.data).toMatchObject({kind:'publication',status:'running',generation:kernel.generation,order:1,completionKnown:false,versionId:null,requestHash:c.digest({...body,name:body.name.trim(),previousVersionId:null})});expect((await db.query('SELECT id FROM managed_artifact_versions')).rows).toHaveLength(0);expect(broker.calls).toHaveLength(calls);}finally{release.resolve();await pending;}
  });
  it('keeps restart identity attached to the previous generation while the one replacement is starting',async()=>{
    const kernel=await start(),entered=deferred(),release=deferred(),body={requestId:randomUUID(),generation:kernel.generation};broker.hooks.beforeStartResponse=async()=>{entered.resolve();await release.promise;};const pending=restart(kernel,body);await entered.promise;
    try{const calls=broker.calls.length,response=await request('/restart-submissions/'+body.requestId);expect(response.data).toMatchObject({kind:'restart',kernelId:kernel.id,generation:kernel.generation,status:'starting',completionKnown:false,requestHash:c.digest({...body,kernelId:kernel.id}),replacementKernelId:expect.stringMatching(c.KERNEL_ID)});expect(broker.calls).toHaveLength(calls);}finally{release.resolve();await pending;}
  });
  it('whitelists metadata rather than leaking source, preview values, bindings, storage keys, inputs, or environment',async()=>{
    const f=await allReceipts(),reads=[];const original=db.query.bind(db);vi.spyOn(db,'query').mockImplementation(async(sql,...args)=>{reads.push(sql);return original(sql,...args);});
    for(const receipt of f.receipts){const response=await request(suffix(receipt));expect(response.status).toBe(200);expect(JSON.stringify(response.data)).not.toMatch(/source_code|n <- 3|stdout|Private saved output|binding|storage|lineage|environment|resources|target|owner_user_id|manifest|result/);expect(Object.keys(response.data)).toEqual(expect.arrayContaining(['requestId','requestHash','kernelId','status','completionKnown']));}
    expect(reads).toHaveLength(4);for(const sql of reads){expect(sql).not.toMatch(/SELECT\s+\*|\bUPDATE\b|\bINSERT\b|\bDELETE\b/i);expect(sql).not.toMatch(/source_code|result_json|lineage_json|storage_key|environment_json|inputs_json/);}
  });
  it('rechecks membership after each exact SQL lookup and exposes no private receipt when access was revoked during inspection',async()=>{
    const f=await allReceipts(),original=db.query.bind(db);
    for(const receipt of f.receipts){let revoked=false;const spy=vi.spyOn(db,'query').mockImplementation(async(sql,...args)=>{const result=await original(sql,...args);if(!revoked&&/AS request_hash/.test(sql)){revoked=true;await original('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[project.id,owner.user.id]);}return result;});
      const response=await request(suffix(receipt));expect(revoked).toBe(true);expect(response.status).toBe(404);expect(JSON.stringify(response.data)).not.toContain(receipt.requestId);spy.mockRestore();await original("INSERT INTO project_members(project_id,user_id,role)VALUES($1,$2,'owner')",[project.id,owner.user.id]);}
  });
});
