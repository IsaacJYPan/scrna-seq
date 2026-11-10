// Disposable local integration test. Fixture setup deliberately acts as its own
// synthetic sponsor; all analysis operations use the real MCP stdio boundary.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = process.cwd();
const work = path.join(root, 'scratch/local-cluster-test');
const output = path.join(root, 'exports/paper-reproduction');
const paper = process.env.PAPER_BENCHMARK === 'true';
const prefix = paper ? 'paper-subset' : 'pbmc3k';
const filename = paper ? 'pbmc68k-subset.h5' : 'pbmc3k.h5';
process.env.DATABASE_URL = 'postgres://postgres:local-fixture-only@127.0.0.1:45432/tro_mcp_test';
process.env.NODE_ENV = 'test';
process.env.DISABLE_RATE_LIMIT = 'true';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.STORAGE_ROOT = path.join(work, 'storage');
process.env.VAULT_ROOT = path.join(work, 'vault');
process.env.SLURM_SSH_TARGET = 'root@127.0.0.1';
process.env.SLURM_SSH_PORT = '43222';
process.env.SLURM_SSH_KEY = path.join(work, 'client');
process.env.SLURM_SSH_KNOWN_HOSTS = path.join(work, 'known_hosts');
process.env.SLURM_REMOTE_ROOT = '/cluster';
process.env.SLURM_PARTITION = 'local';
process.env.SLURM_POLL_SECONDS = '1';
process.env.SLURM_RSCRIPT = '/usr/local/bin/Rscript';
process.env.R_BACKEND_URL = 'http://127.0.0.1:48000';
process.env.API_TOKEN = 'local-test-r-token-0123456789abcdef';
process.env.R_API_TOKEN = process.env.API_TOKEN;
fs.mkdirSync(output, {recursive:true});
const report = { startedAt:new Date().toISOString(), transport:'real SSH/SCP over loopback to Docker', scheduler:'simulated Slurm; executes actual staged job.sh', input:paper?'Frozen random 10,000-cell subset of authors PBMC68k counts':'real PBMC3k counts converted losslessly to 10x HDF5', checks:[] };
let server, child;
const db = require('../../backend/pgDatabase');
const { startServer, createUserWithToken, api } = require('../../backend/_http-test-utils');
const { currentReleases } = require('../../backend/workflowTrust/catalog');
const storage = require('../../backend/storage');
const { createJobWorker } = require('../../backend/jobWorker');
const { createSlurmExecutor } = require('../../backend/executors/slurm');
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); console.log('PASS:',name); };
let serial = 0;
const pending = new Map();
async function rpc(method, params) {
  const id = ++serial;
  const result = new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP request timeout'));},60000);
    pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject});
  });
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  return result;
}
async function tool(name,args={}) {
  const response = await rpc('tools/call',{name,arguments:args});
  if(response.error) throw new Error(JSON.stringify(response.error));
  const text=response.result.content.map(c=>c.text||'').join('\n');
  let data; try {data=JSON.parse(text);} catch {data={message:text};}
  if(response.result.isError) throw Object.assign(new Error(name+': '+text),{data});
  return data;
}
try {
  // This container owns only tro_mcp_test; never reset a shared database.
  assert.equal(new URL(process.env.DATABASE_URL).pathname,'/tro_mcp_test');
  server=await startServer();
  const sponsor=await createUserWithToken({email:`fixture-${Date.now()}@example.invalid`,displayName:'Disposable local test sponsor'});
  const org=await db.createOrganization('Local integration fixture',sponsor.user.id);
  const project=await db.createProject(org.id,'Real PBMC3k through MCP and SSH mock Slurm',sponsor.user.id);
  report.projectId=project.id;
  const provider=storage.createLocalStorageProvider();
  const ds=await db.createDatasetForProject(sponsor.user.id,project.id,{fileType:'tenx_h5',originalFilename:'pbmc3k.h5'});
  const key=storage.projectStorageFileKey(project.id,'datasets',ds.id,'pbmc3k.h5');
  fs.mkdirSync(path.dirname(provider.resolveKey(key)),{recursive:true});
  fs.copyFileSync(path.join(work,filename),provider.resolveKey(key));
  const bytes=fs.readFileSync(provider.resolveKey(key));
  report.inputSha256=crypto.createHash('sha256').update(bytes).digest('hex');
  await db.markDatasetUploaded(project.id,ds.id,{internalStorageKey:key,sha256:report.inputSha256,fileSizeBytes:bytes.length});
  const rel=currentReleases().find(r=>r.key==='seurat-qc-cluster');
  const base=`/api/projects/${project.id}`;
  async function fixturePost(route,body){const r=await api(server,base+route,{method:'POST',token:sponsor.token,body});assert.ok(r.status<300,JSON.stringify(r.data));return r.data;}
  await fixturePost(`/workflow-releases/${rel.id}/approve`,{digest:rel.digest,note:'Disposable local integration fixture only'});
  const parameters=paper?{seed:42,minFeatures:0,applyQcFilter:false,variableFeatures:1000,pcaDims:50,clusterDims:50,umapDims:50,clusterResolution:0.5}:{seed:42,pcaDims:20,clusterDims:10,umapDims:10,clusterResolution:0.5};
  report.parameters=parameters;
  const study=await fixturePost('/studies',{name:`Deterministic real ${prefix} SSH run`,releaseId:rel.id,datasetIds:[ds.id],executionTarget:'slurm',maxTrials:2,maxOutstandingRuns:1,fixedParameters:parameters,variations:{}});
  const delegated=await fixturePost('/agent-delegations',{agentName:'Disposable MCP test agent',capabilities:['metadata.read','results.read','workflow.plan','workflow.executeApproved','run.cancelOwn'],disclosureProfile:'labels'});
  child=spawn(process.execPath,['cli/traceomics-mcp.mjs'],{cwd:root,env:{...process.env,TRACEOMICS_URL:`http://127.0.0.1:${server.address().port}`,TRACEOMICS_AGENT_TOKEN:delegated.credential.token},stdio:['pipe','pipe','pipe'],windowsHide:true});
  createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line);const p=pending.get(r.id);if(p){pending.delete(r.id);p.resolve(r);}});
  child.stderr.on('data',b=>console.error('MCP:',b.toString().slice(0,500)));
  const initialized=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'local-cluster-integration',version:'1'}});
  check('MCP stdio initializes',initialized.result.serverInfo.name==='traceomics');
  const context=await tool('get_context');
  report.context=context;
  await tool('list_datasets',{projectId:project.id});
  await tool('list_workflows',{projectId:project.id});
  const targets=await tool('list_targets',{projectId:project.id});
  report.targets=targets;
  check('SSH target discovery reports available',targets.targets.find(t=>t.kind==='slurm')?.available===true);
  const studies=await tool('list_studies',{projectId:project.id});
  const studyId=study.id||study.study?.id||studies.studies[0].id;
  const bad=await rpc('tools/call',{name:'create_plan',arguments:{projectId:project.id,studyId,datasetId:ds.id,choices:{clusterResolution:10}}});
  check('MCP rejects parameter outside approved study',bad.result.isError===true);
  const plan=await tool('create_plan',{projectId:project.id,studyId,datasetId:ds.id});
  const planId=plan.id||plan.plan.id;
  const submitted=await tool('submit_run',{projectId:project.id,planId,planDigest:plan.digest});
  const runId=submitted.run.id;
  report.runId=runId;
  const replay=await tool('submit_run',{projectId:project.id,planId,planDigest:plan.digest});
  check('Identical MCP submission returns same run',replay.run.id===runId);
  const worker=createJobWorker({db,storageProvider:provider,slurmExecutor:createSlurmExecutor({db}),deriveRObjectStateKey:require('../../backend/rStateKeys').deriveRObjectStateKey,logger:console});
  console.log('Running actual worker with SSH target...');
  const started=Date.now();
  const timer=setInterval(()=>console.log('Analysis in progress:',Math.round((Date.now()-started)/1000),'seconds'),30000);
  try {await worker.runOnce();} finally {clearInterval(timer);}
  const run=await tool('get_run',{projectId:project.id,runId});
  report.run=run;
  const job=(await db.query('SELECT status,error_json,logs_json,result_analysis_object_id FROM jobs WHERE id=(SELECT job_id FROM agent_runs WHERE id=$1)',[runId])).rows[0];
  report.job=job;
  check('Real Seurat SSH job reaches candidate_ready',(run.run||run).state==='candidate_ready');
  report.results=await tool('get_run_results',{projectId:project.id,runId});
  const artifacts=(await db.query("SELECT storage_uri,checksum_sha256,size_bytes FROM job_artifacts WHERE job_id=(SELECT job_id FROM agent_runs WHERE id=$1) AND artifact_type='checkpoint'",[runId])).rows;
  check('Exactly one checkpoint recorded',artifacts.length===1);
  const checkpoint=provider.resolveKey(artifacts[0].storage_uri);
  check('Collected checkpoint SHA-256 matches recorded hash',crypto.createHash('sha256').update(fs.readFileSync(checkpoint)).digest('hex')===artifacts[0].checksum_sha256);
  fs.copyFileSync(checkpoint,path.join(output,`${prefix}-ssh-checkpoint.rds`));
  report.dispatches=(await db.query('SELECT target,slurm_job_id,state FROM hpc_dispatches WHERE job_id=(SELECT job_id FROM agent_runs WHERE id=$1)',[runId])).rows;
  check('Slurm dispatch collected',report.dispatches.some(d=>d.slurm_job_id&&d.state==='collected'));
  if(paper){
    // Synthetic sponsor setup/acceptance is confined to this disposable fixture.
    await fixturePost(`/agent-runs/${runId}/accept`,{expectedAcceptedRunId:null,note:'Fixture acceptance for marker follow-on test; not scientific signoff'});
    const markers=currentReleases().find(r=>r.key==='seurat-markers');
    await fixturePost(`/workflow-releases/${markers.id}/approve`,{digest:markers.digest,note:'Disposable marker test'});
    const follow=await fixturePost('/studies',{name:'Paper subset marker recovery',releaseId:markers.id,sourceStudyId:studyId,maxTrials:1,maxOutstandingRuns:1,fixedParameters:{randomSeed:42,topMarkersPerCluster:20},variations:{}});
    const followPlan=await tool('create_plan',{projectId:project.id,studyId:follow.id,datasetId:follow.inputs[0].datasetId});
    const markerRun=await tool('submit_run',{projectId:project.id,planId:followPlan.id||followPlan.plan.id,planDigest:followPlan.digest});
    report.markerRunId=markerRun.run.id;
    console.log('Running actual checkpoint-backed marker workflow...');
    await worker.runOnce();
    report.markerRun=await tool('get_run',{projectId:project.id,runId:markerRun.run.id});
    if((report.markerRun.run||report.markerRun).state!=='candidate_ready') report.markerJob=(await db.query('SELECT error_json,logs_json FROM jobs WHERE id=(SELECT job_id FROM agent_runs WHERE id=$1)',[markerRun.run.id])).rows[0];
    check('MCP marker follow-on reaches candidate_ready',(report.markerRun.run||report.markerRun).state==='candidate_ready');
    report.markerResults=await tool('get_run_results',{projectId:project.id,runId:markerRun.run.id});
    const markerFiles=(await db.query("SELECT storage_uri FROM job_artifacts WHERE job_id=(SELECT job_id FROM agent_runs WHERE id=$1) AND artifact_type='deg_markers'",[markerRun.run.id])).rows;
    check('App records marker table artifact',markerFiles.length===1);
    fs.copyFileSync(provider.resolveKey(markerFiles[0].storage_uri),path.join(output,'paper-subset-markers.csv'));
  }
  report.status='passed';
} catch(error) {
  report.status='failed';report.error=error.message;console.error(error.stack);process.exitCode=1;
} finally {
  report.finishedAt=new Date().toISOString();
  fs.writeFileSync(path.join(output,paper?'paper-subset-report.json':'local-cluster-report.json'),JSON.stringify(report,null,2));
  if(child) child.kill();
  if(server) await new Promise(resolve=>server.close(resolve));
  await db.close();
}
