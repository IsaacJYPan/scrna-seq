// Parent/sponsor-only governance for a disposable fixture. This file is never
// made available as an analyst tool, and returns no biological feedback.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const runId=process.argv[2];assert.match(runId,/^run_[0-9a-f]{24}$/);
process.env.DATABASE_URL='postgres://postgres:local-fixture-only@127.0.0.1:45432/tro_mcp_study_test';
const db=require('../../backend/pgDatabase');
try{
  const row=(await db.query('SELECT ar.project_id,ar.study_id,u.email FROM agent_runs ar JOIN users u ON u.id=ar.sponsor_user_id WHERE ar.id=$1',[runId])).rows[0];assert.ok(row);
  const access=JSON.parse(fs.readFileSync('scratch/mcp-study/mcp-access.json'));
  const login=await fetch(access.origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:5173'},body:JSON.stringify({email:row.email,password:'password123'})});assert.ok(login.ok);
  const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const base=`/api/projects/${row.project_id}`;
  const post=async(route,body)=>{const r=await fetch(access.origin+base+route,{method:'POST',headers:{Cookie:cookie,Origin:'http://localhost:5173','Content-Type':'application/json'},body:JSON.stringify(body)});const result=await r.json();assert.ok(r.ok,JSON.stringify(result));return result;};
  await post(`/agent-runs/${runId}/accept`,{expectedAcceptedRunId:null,note:'Synthetic sponsor handoff for MCP capability test; not scientific endorsement'});
  const release=require('../../backend/workflowTrust/catalog').currentReleases().find(r=>r.key==='seurat-markers');
  const follow=await post('/studies',{name:'Markers on selected exploratory result',releaseId:release.id,sourceStudyId:row.study_id,maxTrials:1,maxOutstandingRuns:1,fixedParameters:{randomSeed:42,topMarkersPerCluster:20}});
  console.log('MARKER_STUDY_READY '+follow.id);
}finally{await db.close();}
