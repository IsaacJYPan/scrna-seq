import {describe,it,expect} from 'vitest';
const {scientificText}=require('./scientificChoices');
const {currentReleases}=require('./workflowTrust/catalog');
describe('bounded multi-condition scientific configuration',()=>{
 it('allows gene panels and complete annotation data but refuses executable text',()=>{
   expect(scientificText('geneList','ISG15,IFIT1')).toBe('ISG15,IFIT1');
   expect(scientificText('groupMap','0=Myeloid;1=T_cells')).toBe('0=Myeloid;1=T_cells');
   for(const text of ['system(x)','A/B','x\nsource(x)','../../secret',Array(14).fill('G').join(',')])expect(()=>scientificText('geneList',text)).toThrow();
   for(const text of ['0=T;0=M','0=system(x)','0=T;source(x)'])expect(()=>scientificText('groupMap',text)).toThrow();
 });
 it('exposes a pinned multi-sample release and bounded investigation choices',()=>{
   const releases=currentReleases(),multi=releases.find(r=>r.key==='seurat-multisample'),work=releases.find(r=>r.key==='study-workbench');
   expect(multi.definition.parameterSchema.samples.type).toBe('sampleSheet');
   expect(work.definition.parameterSchema.featureNames.type).toBe('geneList');
   expect(work.definition.inputs[0].fromRelease).toContain('seurat-multisample');
   expect(()=>work.validateParameters({recipe:'study_expression',featureNames:'system(x)'})).toThrow();
 });
 it('derives private memory profiles from the trusted job type, preserving interactive/heatmap state',async()=>{
   const {runRBridgeOperation}=require('./rWorkerBridge');
   for(const [operation,jobType,recipe,expected] of [['r.checkpoint.hydrate.v1','deg.find_markers.v1',null,true],['r.checkpoint.hydrate.v1','explore.summarize.v1','figure_heatmap',false],['r.checkpoint.hydrate.v1','explore.summarize.v1','study_de',true]]){
     let body;await runRBridgeOperation({operation,job:{id:'job_test',ownerUserId:1,jobType,parameters:{recipe,expression_only:!expected}},objectContext:{objectId:'ao_1',stateKey:'user-1:obj-ao_1'},checkpoint:{internalStorageKey:'projects/p/checkpoints/j/checkpoint.rds'},input:{expression_only:!expected},callR:async request=>{body=request.body;expect(request.timeoutMs).toBe(600000);return {status:200,body:{loaded:true,checksum_verified:true,runtime_instance_id:'synthetic-profile-test',class:'Seurat',n_cells:10,n_features:20}};}});
     expect(body.expression_only).toBe(expected);
   }
 });
 it('reads a late marker group beyond the global offset cap without exposing arbitrary columns',()=>{
   const {parseDelimited}=require('./artifactPreviews'),{tableGroupFilter}=require('./automation/inspection');
   const source='gene,cluster,p_val\n'+('EARLY,0,0.1\n'.repeat(15000))+'"LATE,GENE",28,0.01\nLAST,28,0.02\n';
   const page=parseDelimited(source,',',{offset:1,limit:1,rowFilter:tableGroupFilter('deg_markers','28')});
   expect(page.rows).toEqual([['LAST','28','0.02']]);expect(page.hasMore).toBe(false);
   expect(()=>tableGroupFilter('exploration_summary','28')).toThrow();
   expect(()=>tableGroupFilter('deg_markers','../../private')).toThrow();
   expect(()=>parseDelimited('gene,value\nG,1\n',',',{rowFilter:tableGroupFilter('deg_markers','28')})).toThrow();
 });
});

describe.skipIf(!process.env.DATABASE_URL)('thirteen-donor MCP admission',()=>{
 it('pins every donor and refuses a nonprimary anchor or changed secondary input',async()=>{
   const db=require('./pgDatabase'),{startServer,createUserWithToken,api}=require('./_http-test-utils'),storage=require('./storage');
   const restoreRuntime=require('./_workflowRuntimeFixture').useWorkflowRuntimeProfile();
   process.env.DISABLE_RATE_LIMIT='true';await db.resetSchemaForTests();const server=await startServer();
   try{
    const owner=await createUserWithToken({email:'multi-admission@example.invalid'}),org=await db.createOrganization('Test',owner.user.id),project=await db.createProject(org.id,'Thirteen donors',owner.user.id),base=`/api/projects/${project.id}`,samples=[];
    const human=async(route,body)=>{const r=await api(server,base+route,{method:'POST',token:owner.token,body});expect(r.status,JSON.stringify(r.data)).toBe(201);return r.data;};
    for(let i=0;i<13;i++){const id=`ds_${i.toString(16).padStart(24,'0')}`;await db.query("INSERT INTO datasets(id,project_id,owner_user_id,created_by_user_id,original_filename,internal_storage_key,file_type,file_size_bytes,sha256,upload_status,validation_status)VALUES($1,$2,$3,$3,'sample.h5',$4,'tenx_h5',100,$5,'uploaded','valid')",[id,project.id,owner.user.id,storage.projectStorageFileKey(project.id,'datasets',id,'sample.h5'),'a'.repeat(64)]);samples.push({datasetId:id,sampleName:`S${i}`,conditionName:i<4?'control':'disease',donorCode:`D${i}`});}
    const release=currentReleases().find(r=>r.key==='seurat-multisample');await human(`/workflow-releases/${release.id}/approve`,{digest:release.digest});
    const study=await human('/studies',{name:'Thirteen-donor input pin',releaseId:release.id,datasetIds:samples.map(s=>s.datasetId),fixedParameters:{samples},variations:{stopAfter:['qc','pca']}});
    const delegation=await human('/agent-delegations',{agentName:'Test',capabilities:['workflow.plan','workflow.executeApproved'],limits:{maxReservedCpuSeconds:100000}});
    const agent=async(route,body)=>api(server,`/api/automation/v1/projects/${project.id}${route}`,{method:'POST',headers:{Authorization:`Bearer ${delegation.credential.token}`},body});
    const wrong=await agent('/plans',{studyId:study.id,datasetId:samples[1].datasetId,choices:{stopAfter:'qc'}});expect(wrong.status,JSON.stringify(wrong.data)).toBe(409);expect(wrong.data.code).toBe('STUDY_AMENDMENT_REQUIRED');
    const plan=await agent('/plans',{studyId:study.id,datasetId:samples[0].datasetId,choices:{stopAfter:'qc'}});expect(plan.status,JSON.stringify(plan.data)).toBe(201);expect(plan.data.plan.inputs.samples).toHaveLength(13);expect(plan.data.plan.parameters.samples).toHaveLength(13);
    await db.query('UPDATE datasets SET sha256=$1 WHERE id=$2',['b'.repeat(64),samples[12].datasetId]);
    const rejected=await agent('/runs',{planId:plan.data.id,planDigest:plan.data.digest,requestId:'changed-last-donor'});expect(rejected.status).toBe(409);expect(rejected.data.code).toBe('INPUT_CHANGED');
    expect((await db.query('SELECT id FROM jobs')).rows).toHaveLength(0);
   }finally{await new Promise(r=>server.close(r));await db.close();restoreRuntime();}
 },120000);
});
