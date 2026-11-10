// Reuse the completed paper clustering when debugging this disposable fixture.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createMcpServer} from '../../cli/traceomics-mcp.mjs';
const require=createRequire(import.meta.url);
const output=path.resolve('exports/paper-reproduction');
const report=JSON.parse(fs.readFileSync(path.join(output,'paper-subset-report.json')));
Object.assign(process.env,{DATABASE_URL:'postgres://postgres:local-fixture-only@127.0.0.1:45432/tro_mcp_test',NODE_ENV:'test',DISABLE_RATE_LIMIT:'true',SESSION_SECRET:crypto.randomBytes(32).toString('hex'),STORAGE_ROOT:path.resolve('scratch/local-cluster-test/storage'),VAULT_ROOT:path.resolve('scratch/local-cluster-test/vault'),R_BACKEND_URL:'http://127.0.0.1:48000',R_API_TOKEN:'local-test-r-token-0123456789abcdef',API_TOKEN:'local-test-r-token-0123456789abcdef'});
const db=require('../../backend/pgDatabase');
const {startServer,api,serverModule}=require('../../backend/_http-test-utils');
const {createJobWorker}=require('../../backend/jobWorker');
const {currentReleases}=require('../../backend/workflowTrust/catalog');
let server;
try{
  server=await startServer();
  const owner=(await db.query('SELECT email FROM users WHERE id=$1',[report.run.run.sponsorUserId])).rows[0];
  const sponsor=await db.getUserByEmail(owner.email);
  sponsor.sessionVersion=await db.getUserSessionVersion(sponsor.id);
  const token=serverModule.issueSession(sponsor);
  const base=`/api/projects/${report.projectId}`;
  async function post(route,body){const r=await api(server,base+route,{method:'POST',token,body});assert.ok(r.status<300,JSON.stringify(r.data));return r.data;}
  // Earlier intentionally failed debug attempts may retain an indeterminate
  // claim. R logs confirmed receipt validation failed before marker execution.
  // Cancel only unfinished marker jobs in this disposable fixture project.
  const unfinished=(await db.query("SELECT id FROM jobs WHERE project_id=$1 AND job_type='deg.find_markers.v1' AND status NOT IN ('completed','failed','canceled')",[report.projectId])).rows;
  for(const job of unfinished) await post(`/jobs/${job.id}/cancel`,{});
  const rel=currentReleases().find(r=>r.key==='seurat-markers');
  const follow=await post('/studies',{name:'Corrected fixture marker follow-on',releaseId:rel.id,sourceStudyId:report.run.run.studyId,maxTrials:1,maxOutstandingRuns:1,fixedParameters:{randomSeed:42,topMarkersPerCluster:20}});
  const d=await post('/agent-delegations',{agentName:'Disposable marker retry',capabilities:['metadata.read','results.read','workflow.plan','workflow.executeApproved']});
  const mcp=createMcpServer({env:{...process.env,TRACEOMICS_URL:`http://127.0.0.1:${server.address().port}`,TRACEOMICS_AGENT_TOKEN:d.credential.token}});
  async function tool(name,args){const r=await mcp.callTool(name,args);const text=r.result.content[0].text;assert.ok(!r.result.isError,text);return JSON.parse(text);}
  await tool('get_context',{});
  const plan=await tool('create_plan',{projectId:report.projectId,studyId:follow.id,datasetId:follow.inputs[0].datasetId});
  const submitted=await tool('submit_run',{projectId:report.projectId,planId:plan.id||plan.plan.id,planDigest:plan.digest});
  report.fixtureCorrections=['Use backend/rStateKeys.js for canonical internal R state keys','Increase disposable R per-session budget from 1 GiB to 3 GiB for the 1.1 GB paper checkpoint'];
  delete report.initialMarkerFixtureFailure;
  report.markerRunId=submitted.run.id;
  await createJobWorker({db,deriveRObjectStateKey:require('../../backend/rStateKeys').deriveRObjectStateKey,logger:console}).runOnce();
  report.markerRun=await tool('get_run',{projectId:report.projectId,runId:submitted.run.id});
  if(report.markerRun.run.state!=='candidate_ready') report.markerJob=(await db.query('SELECT error_json,logs_json FROM jobs WHERE id=(SELECT job_id FROM agent_runs WHERE id=$1)',[submitted.run.id])).rows[0];
  assert.equal(report.markerRun.run.state,'candidate_ready');
  report.markerResults=await tool('get_run_results',{projectId:report.projectId,runId:submitted.run.id});
  const files=(await db.query("SELECT storage_uri FROM job_artifacts WHERE job_id=(SELECT job_id FROM agent_runs WHERE id=$1) AND artifact_type='deg_markers'",[submitted.run.id])).rows;
  assert.equal(files.length,1);
  const provider=require('../../backend/storage').createLocalStorageProvider();
  fs.copyFileSync(provider.resolveKey(files[0].storage_uri),path.join(output,'paper-subset-markers.csv'));
  report.checks.push('MCP marker follow-on reaches candidate_ready','App records marker table artifact');
  delete report.error;delete report.markerJob;report.status='passed';
  console.log('PASS: Real MCP marker follow-on and saved marker table');
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;console.error(error.stack);}
finally{report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'paper-subset-report.json'),JSON.stringify(report,null,2));if(server)await new Promise(r=>server.close(r));await db.close();}
