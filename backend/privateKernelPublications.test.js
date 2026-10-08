import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
const db=require('./pgDatabase');
const {startKernelFixtureBroker,png}=require('./_privateKernelFixtures');
const {createArtifactVersionService}=require('./artifactVersions');
const {createPrivateKernelService}=require('./privateKernelService');
const {createPrivateKernelClient}=require('./privateKernelClient');
const c=require('./privateKernelContract');
let broker,http,server,directory,provider,owner,analyst,viewer,project,settings;
describe.skipIf(!process.env.DATABASE_URL)('creator-private durable console saves through HTTP/PostgreSQL/storage',()=>{
  beforeAll(async()=>{
    settings={...process.env};directory=await mkdtemp(path.join(os.tmpdir(),'traceomics-publications-'));broker=await startKernelFixtureBroker();
    Object.assign(process.env,{STORAGE_ROOT:directory,APP_DEPLOYMENT_MODE:'private',EXPERT_R_ENABLED:'true',EXPERT_R_ACCESS_POLICY:'project-roles',EXPERT_R_SANDBOX_URL:broker.url,EXPERT_R_SANDBOX_TOKEN:broker.token});
    provider={...require('./storage').createLocalStorageProvider()};http=require('./_http-test-utils');server=await http.startServer();
  });
  beforeEach(async()=>{
    vi.restoreAllMocks();await db.resetSchemaForTests();broker.sessions.clear();broker.calls.length=0;for(const key of Object.keys(broker.hooks))delete broker.hooks[key];
    owner=await http.createUserWithToken({email:'save-owner@example.test'});analyst=await http.createUserWithToken({email:'save-analyst@example.test'});viewer=await http.createUserWithToken({email:'save-viewer@example.test'});
    const organization=await db.createOrganizationForUser(owner.user.id,{name:'Save lab'});project=await db.createProjectForUser(owner.user.id,{organizationId:organization.id,name:'Save study'});
    await db.addProjectMemberByEmail(project.id,analyst.user.email,'analyst',{userId:owner.user.id});await db.addProjectMemberByEmail(project.id,viewer.user.email,'viewer',{userId:owner.user.id});
  });
  afterAll(async()=>{vi.restoreAllMocks();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(broker)await broker.close();await db.close();if(directory)await rm(directory,{recursive:true,force:true});for(const key of ['STORAGE_ROOT','APP_DEPLOYMENT_MODE','EXPERT_R_ENABLED','EXPERT_R_ACCESS_POLICY','EXPERT_R_SANDBOX_URL','EXPERT_R_SANDBOX_TOKEN']){if(settings[key]===undefined)delete process.env[key];else process.env[key]=settings[key];}});
  const base=()=>'/api/private-r-kernels/'+project.id;
  const api=(suffix='',options={})=>http.api(server,base()+suffix,{token:owner.token,...options});
  async function start(inputs=[]){const response=await api('',{method:'POST',body:{requestId:randomUUID(),workspaceId:'save_workspace',environment:broker.reference,inputs}});expect(response.status).toBe(200);return response.data;}
  const run=(kernel,source)=>api('/'+kernel.id+'/executions',{method:'POST',body:{requestId:randomUUID(),source}});
  const save=(kernel,body={},options={})=>api('/'+kernel.id+'/publications',{method:'POST',body:{requestId:randomUUID(),name:'Saved research output',type:'object',binding:'n',...body},...options});
  const listing=kernel=>api('/'+kernel.id+'/publications');
  const versionRow=id=>db.query('SELECT * FROM managed_artifact_versions WHERE id=$1',[id]).then(result=>result.rows[0]);
  const service=()=>createPrivateKernelService(db,provider,{client:createPrivateKernelClient({baseUrl:broker.url,token:broker.token}),getEnvironment:()=>broker.manifest});
  async function importFile(bytes='sample,condition\nA,control\n'){const source=path.join(directory,randomUUID());await writeFile(source,bytes);return createArtifactVersionService(db,provider).importFile(owner.user.id,project.id,{path:source,originalFilename:'samples.csv'});}

  it('requires authentication/current write and R access, and keeps saves private from other project members',async()=>{
    const kernel=await start();expect((await save(kernel,{}, {token:null})).status).toBe(401);expect((await save(kernel,{}, {token:viewer.token})).status).toBe(404);expect((await save(kernel,{}, {token:analyst.token})).status).toBe(404);
    const saved=await save(kernel);expect(saved.status).toBe(200);expect((await api('/'+kernel.id+'/publications',{token:analyst.token})).status).toBe(404);
    expect((await http.api(server,'/api/artifact-versions/'+project.id+'/'+saved.data.version.versionId,{token:analyst.token})).status).toBe(404);
    const other=await db.createProjectForUser(owner.user.id,{organizationId:project.organizationId,name:'Other study'});expect((await http.api(server,'/api/private-r-kernels/'+other.id+'/'+kernel.id+'/publications',{token:owner.token})).status).toBe(404);
    await db.query("INSERT INTO platform_capabilities(user_id,capability)VALUES($1,'expert_r.denied')",[owner.user.id]);expect((await save(kernel)).status).toBe(403);
    const evidence=await listing(kernel);expect(evidence.status).toBe(200);expect(evidence.data.items[0].version.versionId).toBe(saved.data.version.versionId);
    expect((await http.api(server,'/api/artifact-versions/'+project.id+'/'+saved.data.version.versionId,{token:owner.token})).status).toBe(200);
  });
  it('reserves exact source/order and lineage before serialization, then atomically publishes immutable verified versions',async()=>{
    const selected=await importFile();const kernel=await start([selected.reference]);await run(kernel,'n <- 3');
    broker.hooks.beforeExportStorage=async(_session,input)=>{const pub=(await db.query('SELECT * FROM private_r_publications WHERE id=$1',[input.publicationId])).rows[0];const source=(await db.query('SELECT * FROM private_r_executions WHERE id=$1',[input.executionId])).rows[0];expect(pub).toMatchObject({status:'running',version_id:expect.stringMatching(/^av_/),kernel_order:2,source_execution_id:input.executionId});expect(source).toMatchObject({source_code:input.source,source_sha256:c.digest(input.source),status:'running'});expect((await versionRow(pub.version_id))).toBeUndefined();};
    const saved=await save(kernel,{type:'table',binding:'counts α with spaces'});expect(saved.status).toBe(200);const {publication,version}=saved.data;
    expect(publication).toMatchObject({status:'completed',order:2,sourceExecutionId:expect.stringMatching(/^pex_/),lineage:{environment:broker.reference,inputs:[{reference:selected.reference}],sourceVersions:[{order:1,status:'completed'}],replay:{complete:false}}});
    expect(version).toMatchObject({type:'table',format:{id:'org.ietf.csv'},sourcePublicationId:publication.id,provenance:{sourceExecutionId:publication.sourceExecutionId,sourceSha256:publication.sourceSha256,publicationId:publication.id},versionNumber:1});
    const native=broker.calls.find(call=>call.path.endsWith('/export')).input;expect(native.source).toContain(JSON.stringify('counts α with spaces'));expect(JSON.stringify(saved.data)).not.toMatch(/internalStorageKey|storage_key|Bearer|containerName/);
    const journal=(await db.query('SELECT * FROM private_r_executions WHERE id=$1',[publication.sourceExecutionId])).rows[0];expect(c.digest(journal.source_code)).toBe(publication.sourceSha256);expect(journal.status).toBe('completed');
    const row=await versionRow(version.versionId);expect(await readFile(provider.resolveKey(row.storage_key),'utf8')).toBe('sample,condition\nS1,treated\n');
    await expect(db.query('UPDATE managed_artifact_versions SET name=$2 WHERE id=$1',[version.versionId,'Altered'])).rejects.toThrow();await expect(db.query('UPDATE private_r_publications SET kernel_order=3 WHERE id=$1',[publication.id])).rejects.toThrow();
    const history=await http.api(server,'/api/execution-history/'+project.id+'/'+publication.sourceExecutionId,{token:owner.token});expect(history.data.outputs[0].reference).toEqual(version.reference);expect(history.data.replay.issues.some(item=>item.code==='console-previews-not-artifacts')).toBe(false);
  });
  it('reuses a request’s original bytes after further commands and rejects changed request settings without rerunning',async()=>{
    const kernel=await start();const requestId=randomUUID();const original=await save(kernel,{requestId});await run(kernel,'n <- 9');
    const repeat=await save(kernel,{requestId});expect(repeat.data.version.versionId).toBe(original.data.version.versionId);expect((await save(kernel,{requestId,binding:'other'})).status).toBe(409);expect(broker.calls.filter(call=>call.path.endsWith('/export'))).toHaveLength(1);expect((await listing(kernel)).data.items).toHaveLength(1);
  });
  it('saves only exact retained completed PNG bytes, including after stop, without dispatching another R command',async()=>{
    const kernel=await start();const command=(await run(kernel,'plot(n)')).data;await api('/'+kernel.id+'/stop',{method:'POST',body:{}});
    const body={requestId:randomUUID(),name:'Retained plot',type:'figure',executionId:command.id,figureIndex:0};const saved=await api('/'+kernel.id+'/publications',{method:'POST',body});expect(saved.status).toBe(200);expect(saved.data.publication.order).toBe(command.order);expect(saved.data.version).toMatchObject({sha256:c.digest(png),type:'image',format:{id:'org.w3.png'}});
    const row=await versionRow(saved.data.version.versionId);expect(await readFile(provider.resolveKey(row.storage_key))).toEqual(png);expect(broker.calls.filter(call=>call.path.endsWith('/export'))).toHaveLength(0);
    expect((await api('/'+kernel.id+'/publications',{method:'POST',body:{...body,requestId:randomUUID(),figureIndex:3}})).status).toBe(400);expect((await api('/'+kernel.id+'/publications',{method:'POST',body:{...body,requestId:randomUUID(),data:png.toString('base64')}})).status).toBe(400);
    expect((await save(kernel)).status).toBe(409);const preview=await http.api(server,'/api/artifact-versions/'+project.id+'/'+saved.data.version.versionId+'/preview',{token:owner.token});expect(preview.data.preview.family).toBe('image');
  });
  it('creates immutable replacement versions and rejects a different format or another creator’s prior version',async()=>{
    const kernel=await start();const first=await save(kernel);broker.hooks.exportBytes=()=>Buffer.from('New opaque RDS version');const second=await save(kernel,{name:'Revision two',previousVersionId:first.data.version.versionId});expect(second.status).toBe(200);expect(second.data.version).toMatchObject({artifactId:first.data.version.artifactId,versionNumber:2,previousVersionId:first.data.version.versionId});
    expect((await save(kernel,{type:'table',previousVersionId:first.data.version.versionId})).status).toBe(409);const old=await versionRow(first.data.version.versionId);expect(await readFile(provider.resolveKey(old.storage_key),'utf8')).toBe('Opaque fixture RDS bytes');
    await api('/'+kernel.id+'/stop',{method:'POST',body:{}});const started=await api('',{token:analyst.token,method:'POST',body:{requestId:randomUUID(),workspaceId:'analyst_save',environment:broker.reference,inputs:[]}});expect((await save(started.data,{previousVersionId:first.data.version.versionId},{token:analyst.token})).status).toBe(404);
  });
  it('preserves complete wide or long-cell serialized CSV while falling back to bounded metadata inspection',async()=>{
    const kernel=await start();const bytes=Array.from({length:125},(_,index)=>'column_'+index).join(',')+'\n'+Array.from({length:125},(_,index)=>index===0?'x'.repeat(5000):index).join(',')+'\n';broker.hooks.exportBytes=()=>Buffer.from(bytes);
    const saved=await save(kernel,{type:'table'});expect(saved.status).toBe(200);expect(saved.data.version.sizeBytes).toBe(Buffer.byteLength(bytes));const preview=await http.api(server,'/api/artifact-versions/'+project.id+'/'+saved.data.version.versionId+'/preview',{token:owner.token});expect(preview.status).toBe(200);expect(preview.data).toMatchObject({integrityVerified:true,preview:{family:'metadata'}});
  });
  it('refreshes a disconnected export from remembered original evidence without ever repeating serialization',async()=>{
    const kernel=await start();broker.hooks.beforeExportResponse=(_session,_receipt,request)=>request.socket.destroy();const requestId=randomUUID();const lost=await save(kernel,{requestId});expect(lost.status).toBe(200);expect(lost.data).toMatchObject({version:null,publication:{status:'unknown'}});expect((await run(kernel,'n <- 9')).status).toBe(409);
    delete broker.hooks.beforeExportResponse;const refreshed=await listing(kernel);expect(refreshed.data.items[0].status).toBe('completed');expect(refreshed.data.items[0].version).toBeTruthy();expect((await save(kernel,{requestId})).data.version.versionId).toBe(refreshed.data.items[0].version.versionId);expect(broker.calls.filter(call=>call.path.endsWith('/export'))).toHaveLength(1);expect(broker.calls.filter(call=>call.path.endsWith('/export-status')).length).toBeGreaterThan(0);
  });
  it('rejects actual checksum corruption, oversize descriptors and changed generation before any version is admitted',async()=>{
    const kernel=await start();broker.hooks.beforeExportResponse=(_session,receipt)=>{receipt.file.checksumSha256='f'.repeat(64);};const corrupted=await save(kernel);expect(corrupted.status).toBe(409);expect(corrupted.data.code).toBe('PRIVATE_KERNEL_PUBLICATION_INTEGRITY');expect((await db.query('SELECT * FROM managed_artifact_versions')).rows).toHaveLength(0);const failed=(await listing(kernel)).data.items[0];expect(failed.status).toBe('failed');
    broker.hooks.beforeExportResponse=(_session,receipt)=>{receipt.file.sizeBytes=20*1024*1024+1;};const oversized=await save(kernel);expect(oversized.data.publication.status).toBe('unknown');expect((await db.query('SELECT * FROM managed_artifact_versions')).rows).toHaveLength(0);
    await api('/'+kernel.id+'/stop',{method:'POST',body:{}});
  });
  it('keeps export serialization exclusive through byte verification and rejects publication if stopped during verification',async()=>{
    const kernel=await start();const original=provider.openVerifiedRead;let entered,release;const hashing=new Promise(resolve=>{entered=resolve;});vi.spyOn(provider,'openVerifiedRead').mockImplementationOnce(async(...args)=>{const opened=await original(...args);entered();await new Promise(resolve=>{release=resolve;});return opened;});
    const current=service();const pending=current.publish(owner.user.id,project.id,kernel.id,{requestId:randomUUID(),name:'Stopped save',type:'object',binding:'n'});await hashing;
    expect((await run(kernel,'n <- 9')).status).toBe(409);await current.stop(owner.user.id,project.id,kernel.id);release();await expect(pending).rejects.toMatchObject({code:'PRIVATE_KERNEL_PUBLICATION_CONFLICT'});expect((await db.query('SELECT * FROM managed_artifact_versions')).rows).toHaveLength(0);const pub=(await db.query('SELECT * FROM private_r_publications')).rows[0];expect(pub.status).toBe('failed');await expect(readFile(provider.resolveKey(pub.storage_key))).rejects.toThrow();
  });
  it('rechecks membership after file hashing and stops a revoked session without exposing or publishing its output',async()=>{
    const kernel=await start();const original=provider.openVerifiedRead;vi.spyOn(provider,'openVerifiedRead').mockImplementationOnce(async(...args)=>{const opened=await original(...args);await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[project.id,owner.user.id]);return opened;});
    await expect(service().publish(owner.user.id,project.id,kernel.id,{requestId:randomUUID(),name:'Revoked save',type:'table',binding:'n'})).rejects.toMatchObject({code:'NOT_FOUND'});expect((await db.query('SELECT * FROM managed_artifact_versions')).rows).toHaveLength(0);expect(broker.sessions.get(kernel.id).status).toBe('stopped');
  });
  it('retains private source/result evidence but refuses a save when execution access is revoked at the runtime response',async()=>{
    const kernel=await start();broker.hooks.beforeExportResponse=async()=>{await db.query("INSERT INTO platform_capabilities(user_id,capability)VALUES($1,'expert_r.denied')",[owner.user.id]);};const rejected=await save(kernel);expect(rejected.status).toBe(403);expect((await db.query('SELECT * FROM managed_artifact_versions')).rows).toHaveLength(0);expect(broker.sessions.get(kernel.id).status).toBe('stopped');const evidence=(await listing(kernel)).data.items[0];expect(evidence.status).toBe('failed');const history=await http.api(server,'/api/execution-history/'+project.id+'/'+evidence.sourceExecutionId,{token:owner.token});expect(history.status).toBe(200);expect(history.data.status).toBe('completed');
  });
  it('reserves quota before export and counts an active reservation against generic imports and another figure save',async()=>{
    const imported=await importFile();const template=await versionRow(imported.versionId);
    await db.query(`INSERT INTO managed_artifact_versions(id,artifact_id,project_id,owner_user_id,name,version_number,artifact_type,format_json,mime_type,checksum_sha256,size_bytes,storage_key) SELECT 'av_'||lpad(to_hex(n),24,'0'),$1,$2,$3,$4,n+1,$5,$6,$7,$8,$9,replace($10,$11,'av_'||lpad(to_hex(n),24,'0')) FROM generate_series(1,198) n`,[template.artifact_id,project.id,owner.user.id,template.name,template.artifact_type,template.format_json,template.mime_type,template.checksum_sha256,template.size_bytes,template.storage_key,template.id]);
    const kernel=await start();const figure=(await run(kernel,'plot(n)')).data;let entered,release;const waiting=new Promise(resolve=>{entered=resolve;});broker.hooks.beforeExportStorage=async()=>{entered();await new Promise(resolve=>{release=resolve;});};const pending=save(kernel);await waiting;
    const rejected=await api('/'+kernel.id+'/publications',{method:'POST',body:{requestId:randomUUID(),name:'No quota',type:'figure',executionId:figure.id,figureIndex:0}});expect(rejected.status).toBe(409);expect(rejected.data.code).toBe('ARTIFACT_STORAGE_LIMIT');await expect(importFile()).rejects.toMatchObject({code:'ARTIFACT_STORAGE_LIMIT'});release();expect((await pending).data.publication.status).toBe('completed');expect((await save(kernel)).status).toBe(409);expect(broker.calls.filter(call=>call.path.endsWith('/export'))).toHaveLength(1);
  });
  it('rejects unsupported save capability and invalid bindings/cursors without scientific dispatch or reservations',async()=>{
    const kernel=await start();broker.hooks.publicationsEnabled=false;expect((await save(kernel)).status).toBe(503);expect((await db.query('SELECT * FROM private_r_publications')).rows).toHaveLength(0);expect((await run(kernel,'n <- 3')).status).toBe(200);
    delete broker.hooks.publicationsEnabled;for(const binding of ['', 'x\0y', 'x\ny','α'.repeat(129)])expect((await save(kernel,{binding})).status).toBe(400);expect((await api('/'+kernel.id+'/publications?limit=31')).status).toBe(400);expect((await api('/'+kernel.id+'/publications?before='+'x'.repeat(257))).status).toBe(400);expect(broker.calls.filter(call=>call.path.endsWith('/export'))).toHaveLength(0);
  });
  it('records a failed R binding save and releases its quota without publishing partial bytes',async()=>{
    const kernel=await start();const failed=await save(kernel,{binding:'missing_fixture'});expect(failed.status).toBe(200);expect(failed.data).toMatchObject({version:null,publication:{status:'failed'}});expect((await db.query('SELECT * FROM managed_artifact_versions')).rows).toHaveLength(0);const journal=(await db.query('SELECT * FROM private_r_executions WHERE id=$1',[failed.data.publication.sourceExecutionId])).rows[0];expect(journal.status).toBe('failed');expect((await run(kernel,'n <- 2')).status).toBe(200);
  });
  it('keeps the kernel unknown after a definitive pre-dispatch refusal rather than pretending its reserved order was consumed',async()=>{
    const kernel=await start();const native=createPrivateKernelClient({baseUrl:broker.url,token:broker.token});const current=createPrivateKernelService(db,provider,{client:{...native,export:async()=>{throw c.kernelError('PRIVATE_KERNEL_ORDER_INVALID','Rejected order.',409);}},getEnvironment:()=>broker.manifest});
    await expect(current.publish(owner.user.id,project.id,kernel.id,{requestId:randomUUID(),name:'Refused save',type:'object',binding:'n'})).rejects.toMatchObject({code:'PRIVATE_KERNEL_ORDER_INVALID'});
    const row=(await db.query('SELECT * FROM private_r_kernels WHERE id=$1',[kernel.id])).rows[0];expect(row).toMatchObject({status:'unknown',active_execution_id:expect.stringMatching(/^pex_/)});expect(Number(row.next_order)).toBe(1);expect(broker.sessions.get(kernel.id).order).toBe(0);expect((await run(kernel,'n <- 3')).status).toBe(409);
  });
  it('keeps failed-cleanup bytes and version capacity reserved instead of hiding an unremoved storage object',async()=>{
    const kernel=await start();broker.hooks.beforeExportResponse=(_session,receipt)=>{receipt.file.checksumSha256='f'.repeat(64);};vi.spyOn(provider,'remove').mockImplementation(()=>{throw Object.assign(new Error('Storage cleanup failed.'),{code:'STORAGE_IO'});});
    await expect(service().publish(owner.user.id,project.id,kernel.id,{requestId:randomUUID(),name:'Unconfirmed cleanup',type:'object',binding:'n'})).rejects.toMatchObject({code:'PRIVATE_KERNEL_PUBLICATION_INTEGRITY'});
    const pub=(await db.query('SELECT * FROM private_r_publications')).rows[0];expect(pub.status).toBe('unknown');expect(await readFile(provider.resolveKey(pub.storage_key))).toBeTruthy();
    await expect(createArtifactVersionService(db,provider).assertCapacity(db,owner.user.id,project.id,1024*1024*1024-pub.reserved_bytes+1)).rejects.toMatchObject({code:'ARTIFACT_STORAGE_LIMIT'});
  });
  it('permits lifecycle cleanup with a replacement’s deferred publication-to-version foreign key while preserving evidence before deletion',async()=>{
    const kernel=await start();const first=await save(kernel);const second=await save(kernel,{previousVersionId:first.data.version.versionId});expect(second.status).toBe(200);
    const connection=await (await db.connect()).connect();try{await connection.query('BEGIN');await connection.query('DELETE FROM managed_artifact_versions WHERE project_id=$1',[project.id]);await connection.query('DELETE FROM private_r_publications WHERE project_id=$1',[project.id]);await connection.query('DELETE FROM private_r_executions WHERE project_id=$1',[project.id]);await connection.query('DELETE FROM private_r_kernels WHERE project_id=$1',[project.id]);await connection.query('COMMIT');}catch(failure){await connection.query('ROLLBACK');throw failure;}finally{connection.release();}
    expect((await db.query('SELECT * FROM private_r_publications')).rows).toHaveLength(0);expect((await db.query('SELECT * FROM managed_artifact_versions')).rows).toHaveLength(0);
  });
  it('recovers an interrupted figure reservation only from exact journal PNG and verified existing bytes, and cleans missing/corrupt copies',async()=>{
    const kernel=await start();const command=(await run(kernel,'plot(n)')).data;const original=await api('/'+kernel.id+'/publications',{method:'POST',body:{requestId:randomUUID(),name:'Original PNG',type:'figure',executionId:command.id,figureIndex:0}});const row=(await db.query('SELECT * FROM private_r_publications WHERE id=$1',[original.data.publication.id])).rows[0];
    async function pendingFigure(state,bytes){const publicationId='pub_'+randomUUID().replaceAll('-','').slice(0,24),versionId='av_'+randomUUID().replaceAll('-','').slice(0,24),artifactId='af_'+randomUUID().replaceAll('-','').slice(0,24);const key=require('./storage').projectStorageFileKey(project.id,'artifacts',versionId,'content.png');
      await db.query(`INSERT INTO private_r_publications(id,kernel_id,project_id,owner_user_id,request_id,request_sha256,status,publication_type,name,source_execution_id,kernel_generation,kernel_order,figure_index,artifact_id,version_id,storage_key,reserved_bytes,lineage_json) VALUES($1,$2,$3,$4,$5,$6,$7,'figure',$8,$9,$10,$11,0,$12,$13,$14,$15,$16)`,[publicationId,kernel.id,project.id,owner.user.id,randomUUID(),c.digest(publicationId),state,'Interrupted '+state,command.id,kernel.generation,command.order,artifactId,versionId,key,png.length,row.lineage_json]);if(bytes)await writeFile(provider.prepareWrite(key),bytes);return {publicationId,versionId,key};}
    const complete=await pendingFigure('unknown',png),missing=await pendingFigure('reserved'),corrupt=await pendingFigure('running',Buffer.from('Corrupted PNG'));
    await api('/'+kernel.id+'/stop',{method:'POST',body:{}});const calls=broker.calls.length;const refreshed=await listing(kernel);expect(refreshed.status).toBe(200);const byId=new Map(refreshed.data.items.map(item=>[item.id,item]));expect(byId.get(complete.publicationId)).toMatchObject({status:'completed',version:{sha256:c.digest(png)}});expect(byId.get(missing.publicationId).status).toBe('failed');expect(byId.get(corrupt.publicationId).status).toBe('failed');await expect(readFile(provider.resolveKey(corrupt.key))).rejects.toThrow();expect(broker.calls.length).toBe(calls);expect((await versionRow(complete.versionId)).checksum_sha256).toBe(c.digest(png));
  });
  it('fences a delayed figure writer from overlapping missing-file recovery instead of recreating a failed key',async()=>{
    const kernel=await start();const command=(await run(kernel,'plot(n)')).data;const fileOps=require('node:fs/promises'),open=fileOps.open;let entered,release;const paused=new Promise(resolve=>{entered=resolve;});
    vi.spyOn(fileOps,'open').mockImplementation(async(filename,flags,...args)=>{if(flags==='wx'&&String(filename).endsWith('content.png')){entered();await new Promise(resolve=>{release=resolve;});}return open(filename,flags,...args);});
    const pending=service().publish(owner.user.id,project.id,kernel.id,{requestId:randomUUID(),name:'Delayed PNG',type:'figure',executionId:command.id,figureIndex:0});await paused;
    let ended=false;const recovery=listing(kernel).then(value=>{ended=true;return value;});await new Promise(resolve=>setTimeout(resolve,40));expect(ended).toBe(false);release();const published=await pending,refreshed=await recovery;expect(published.publication.status).toBe('completed');expect(refreshed.data.items[0]).toMatchObject({status:'completed',version:{versionId:published.version.versionId}});expect((await db.query('SELECT * FROM managed_artifact_versions')).rows).toHaveLength(1);expect(broker.calls.filter(call=>call.path.endsWith('/export'))).toHaveLength(0);
  });
  it('settles unconfirmed save capacity after a confirmed stop even if the runtime export receipt expired, without inventing source completion',async()=>{
    const kernel=await start();broker.hooks.beforeExportResponse=(_session,_receipt,request)=>request.socket.destroy();const lost=await save(kernel);expect(lost.data.publication.status).toBe('unknown');const pub=(await db.query('SELECT * FROM private_r_publications WHERE id=$1',[lost.data.publication.id])).rows[0];broker.sessions.get(kernel.id).exports.clear();
    await api('/'+kernel.id+'/stop',{method:'POST',body:{}});const evidence=(await listing(kernel)).data.items[0];expect(evidence.status).toBe('failed');expect(evidence.version).toBeNull();await expect(readFile(provider.resolveKey(pub.storage_key))).rejects.toThrow();expect((await db.query('SELECT status FROM private_r_executions WHERE id=$1',[pub.source_execution_id])).rows[0].status).toBe('unknown');
    await expect(createArtifactVersionService(db,provider).assertCapacity(db,owner.user.id,project.id,1024*1024*1024)).resolves.toBeUndefined();expect(broker.calls.filter(call=>call.path.endsWith('/export'))).toHaveLength(1);
  });
});
