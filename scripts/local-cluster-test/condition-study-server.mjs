// Synthetic sponsor only. No reference outcomes are used to authorize a run.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {readinessGate} from './evolved-readiness.mjs';
const require=createRequire(import.meta.url),work=path.resolve('scratch/condition-study'),out=path.resolve('exports/condition-study/blinded');fs.mkdirSync(out,{recursive:true});
Object.assign(process.env,{DATABASE_URL:'postgres://postgres:local-fixture-only@127.0.0.1:45433/tro_condition_test',NODE_ENV:'test',DISABLE_RATE_LIMIT:'true',SESSION_SECRET:crypto.randomBytes(32).toString('hex'),STORAGE_ROOT:path.join(work,'storage'),VAULT_ROOT:path.join(work,'vault'),R_BACKEND_URL:'http://127.0.0.1:48001',API_TOKEN:'local-test-r-token-0123456789abcdef',R_API_TOKEN:'local-test-r-token-0123456789abcdef',TRACEOMICS_WORKFLOW_RUNTIME_FILE:path.join(work,'runtime.json')});
const db=require('../../backend/pgDatabase'),storage=require('../../backend/storage'),{startServer,createUserWithToken,api}=require('../../backend/_http-test-utils'),{currentReleases}=require('../../backend/workflowTrust/catalog'),{createJobWorker}=require('../../backend/jobWorker');
const restore=process.env.CONDITION_REUSE==='true'?JSON.parse(fs.readFileSync(path.join(out,'fixture-identifiers.json'))):null;
const server=await startServer();let owner,project;
if(restore){const {rows}=await db.query('SELECT u.email FROM users u JOIN study_envelopes s ON s.created_by_user_id=u.id WHERE s.id=$1 AND s.project_id=$2',[restore.sourceStudyId,restore.projectId]);if(rows.length!==1)throw new Error('Cannot restore synthetic sponsor');const user=await db.getUserByEmail(rows[0].email);user.sessionVersion=await db.getUserSessionVersion(user.id);owner={user,token:require('../../server.js').issueSession(user)};project={id:restore.projectId};}
else{owner=await createUserWithToken({email:`condition-blind-${Date.now()}@example.invalid`});const org=await db.createOrganization('Local study validation',owner.user.id);project=await db.createProject(org.id,'Anonymous multi-donor respiratory study',owner.user.id);}
const base=`/api/projects/${project.id}`;
async function post(route,body){const r=await api(server,base+route,{method:'POST',token:owner.token,body});if(r.status>=300)throw new Error(JSON.stringify(r.data));return r.data;}
const provider=storage.createLocalStorageProvider(),manifest=JSON.parse(fs.readFileSync(path.join(work,'sponsor-inputs.json'))),samples=[];
if(restore){const {rows}=await db.query('SELECT protected_json FROM study_envelopes WHERE id=$1',[restore.sourceStudyId]);samples.push(...rows[0].protected_json.samples);}
else for(const row of manifest){const ds=await db.createDatasetForProject(owner.user.id,project.id,{fileType:'tenx_h5',originalFilename:row.file}),key=storage.projectStorageFileKey(project.id,'datasets',ds.id,row.file);fs.mkdirSync(path.dirname(provider.resolveKey(key)),{recursive:true});fs.copyFileSync(path.join(work,'inputs',row.file),provider.resolveKey(key));await db.markDatasetUploaded(project.id,ds.id,{internalStorageKey:key,sha256:row.sha256,fileSizeBytes:fs.statSync(provider.resolveKey(key)).size});await db.query("UPDATE datasets SET validation_status='valid' WHERE id=$1",[ds.id]);samples.push({datasetId:ds.id,sampleName:row.sampleName,conditionName:row.conditionName,donorCode:row.donorCode,batch:row.batch});}
const releases=currentReleases();for(const r of releases)await post(`/workflow-releases/${r.id}/approve`,{digest:r.digest});
const reuseCurrentSource=restore&&process.env.CONDITION_SERVE_ONLY==='true'&&(await db.query('SELECT release_id FROM study_envelopes WHERE id=$1',[restore.sourceStudyId])).rows[0]?.release_id===releases.find(r=>r.key==='seurat-multisample').id;
const source=reuseCurrentSource?{id:restore.sourceStudyId}:await post('/studies',{name:'Inspect all donors and develop an atlas',objective:'Study BALF from independent human donors: control versus moderate and severe respiratory infection. Inspect QC and PCA, assess donor/chemistry confounding, select justified clustering, then investigate population and condition differences.',releaseId:releases.find(r=>r.key==='seurat-multisample').id,datasetIds:samples.map(s=>s.datasetId),maxTrials:20,maxCpuSeconds:150000,fixedParameters:{samples,minFeatures:200,minFeaturesFilter:200,minCountsFilter:0,seed:42,pcaDims:30,clusterDims:30,umapDims:30},variations:{stopAfter:['qc','normalize','pca','cluster','umap'],applyQcFilter:[false,true],maxFeaturesFilter:[2500,6000,10000],maxPercentMt:[5,10,20],clusterResolution:[0.25,0.5,0.8,1.2],integrationMethod:['none','rpca']}});
const tokenFile=path.join(work,'blind-agent-token');if(!restore){const delegation=await post('/agent-delegations',{agentName:'Blinded condition-study analyst',capabilities:['metadata.read','results.read','results.inspect','proposal.create','workflow.plan','workflow.executeApproved','run.cancelOwn'],disclosureProfile:'labels',limits:{maxReservedCpuSeconds:1500000}});fs.writeFileSync(tokenFile,delegation.credential.token,{mode:0o600});}
if(restore&&process.env.CONDITION_SERVE_ONLY==='true')await db.query("UPDATE study_envelopes s SET status='closed',closed_at=now() FROM workflow_releases r WHERE s.project_id=$1 AND s.release_id=r.id AND r.status='superseded' AND s.status='open'",[project.id]);
if(restore&&process.env.CONDITION_SERVE_ONLY!=='true')await db.query("UPDATE study_envelopes SET status='closed',closed_at=now() WHERE project_id=$1 AND id<>$2 AND status='open'",[project.id,source.id]);
fs.writeFileSync(path.join(work,'blind-mcp-access.json'),JSON.stringify({origin:`http://127.0.0.1:${server.address().port}`,tokenFile}));fs.writeFileSync(path.join(work,'sponsor-session.json'),JSON.stringify({origin:`http://127.0.0.1:${server.address().port}`,token:owner.token,projectId:project.id}));fs.writeFileSync(path.join(out,'fixture-identifiers.json'),JSON.stringify({projectId:project.id,sourceStudyId:source.id,datasetId:samples[0].datasetId}));
const worker=createJobWorker({db,claimGate:readinessGate(process.env.STORAGE_ROOT),storageProvider:provider,deriveRObjectStateKey:require('../../backend/rStateKeys').deriveRObjectStateKey,logger:console});worker.start();console.log('CONDITION_BLIND_MCP_READY');
let busy=false;const control=path.join(work,'blind-control.json');
const timer=setInterval(async()=>{if(busy||!fs.existsSync(control))return;busy=true;try{const command=JSON.parse(fs.readFileSync(control));fs.unlinkSync(control);
if(command.action==='accept'){
 const selected=await db.query("SELECT ar.id,ar.study_id FROM agent_runs ar JOIN jobs j ON j.id=ar.job_id WHERE ar.id=$1 AND ar.project_id=$2 AND j.status=$3 AND j.job_type='seurat.multisample.v1'",[command.runId,project.id,'completed']);if(!selected.rows.length)throw new Error('Not a completed source-study run');
 const selectedSource=selected.rows[0].study_id;
 const prior=await db.query('SELECT accepted_run_id FROM study_envelopes WHERE id=$1',[selectedSource]);
 await post(`/agent-runs/${command.runId}/accept`,{expectedAcceptedRunId:prior.rows[0].accepted_run_id,note:'Synthetic sponsor accepts the blinded analyst selection; no reference feedback.'});
 const round=Date.now();
 const settings=[['seurat-markers',{randomSeed:42,topMarkersPerCluster:30},{maxCellsPerIdent:[2000,null]}],['standard-figures',{}, {recipe:['figure_qc','figure_pca','figure_umap','figure_heatmap','figure_dot','figure_feature']}]];
 for(const [key,fixedParameters,variations] of settings)await post('/studies',{name:`${key} handoff ${round}`,releaseId:releases.find(r=>r.key===key).id,sourceStudyId:selectedSource,maxTrials:20,maxCpuSeconds:100000,fixedParameters,variations});
 // What a study asks is fixed by the sponsor: the condition, the group map,
 // the registered contrast and the target population. Only the display gene
 // panel may vary. Contrast recipes need a contrast registered on the selected
 // result (TRACEOMICS_STUDY_CONTRAST_ID); without one they are skipped.
 const contrastId=process.env.TRACEOMICS_STUDY_CONTRAST_ID;
 const studies=[];
 for(const conditionName of ['all','control','moderate','severe']){
  for(const recipe of ['study_composition','study_qc','study_expression'])studies.push({recipe,conditionName});
  if(conditionName!=='all')studies.push({recipe:'study_communication',conditionName});
 }
 if(contrastId){
  studies.push({recipe:'study_de',contrastId});
  for(const targetGroup of (process.env.TRACEOMICS_STUDY_TARGET_GROUPS||'').split(',').filter(Boolean))studies.push({recipe:'study_pathways',contrastId,targetGroup});
 }else console.log('SKIP study_de/study_pathways: set TRACEOMICS_STUDY_CONTRAST_ID to a registered contrast');
 for(const fixedParameters of studies){
  const variations=['study_expression','study_de','study_pathways'].includes(fixedParameters.recipe)?{featureNames:['','*']}:{};
  const label=[fixedParameters.recipe,fixedParameters.conditionName,fixedParameters.targetGroup].filter(Boolean).join(' ');
  await post('/studies',{name:`${label} handoff ${round}`,releaseId:releases.find(r=>r.key==='study-workbench').id,sourceStudyId:selectedSource,maxTrials:60,maxCpuSeconds:250000,fixedParameters,variations});
 }
 fs.writeFileSync(path.join(out,'sponsor-handoff.json'),JSON.stringify({selectedRunId:command.runId,completedAt:new Date().toISOString()}));console.log('DOWNSTREAM_STUDIES_READY');
}else if(command.action==='shutdown'){clearInterval(timer);await worker.stop();await new Promise(r=>server.close(r));await db.close();process.exit(0);}
}catch(error){console.error('CONTROL_ERROR',error.message);}finally{busy=false;}},1000);
