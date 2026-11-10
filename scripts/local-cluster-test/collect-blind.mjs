// Parent-only collection after the analyst has locked its final selection.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const output=path.resolve('exports/blind-study');
const work=path.resolve('scratch/blind-study');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const selection=JSON.parse(fs.readFileSync(path.join(output,'locked-selection.json')));
assert.equal(digest(path.join(work,'reference/preregistered.json')),fs.readFileSync(path.join(work,'reference/preregistered.sha256'),'utf8'));
assert.equal(digest(path.join(output,'agent-conclusion.txt')),selection.conclusionSha256);
process.env.DATABASE_URL='postgres://postgres:local-fixture-only@127.0.0.1:45432/tro_blind_test';
const db=require('../../backend/pgDatabase');
try{
  const rows=(await db.query("SELECT a.storage_uri,a.checksum_sha256,j.status FROM job_artifacts a JOIN jobs j ON j.id=a.job_id WHERE a.artifact_type='checkpoint' AND j.id=$1 AND j.result_analysis_object_id=$2",[selection.jobId,selection.analysisObjectId])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].status,'completed');
  const checkpoint=path.join(work,'storage',...rows[0].storage_uri.split('/'));
  assert.equal(digest(checkpoint),rows[0].checksum_sha256);
  fs.copyFileSync(checkpoint,path.join(output,'selected-checkpoint.rds'));
  const recorded=(await db.query('SELECT j.id AS job_id,j.parameters_json,a.id AS analysis_object_id,a.metadata_json FROM jobs j JOIN analysis_objects a ON a.id=j.result_analysis_object_id WHERE j.id=$1',[selection.jobId])).rows[0];
  fs.writeFileSync(path.join(output,'app-selected-result.json'),JSON.stringify(recorded,null,2));
  const markers=(await db.query("SELECT j.id,j.parameters_json,a.storage_uri,a.checksum_sha256 FROM jobs j JOIN job_artifacts a ON a.job_id=j.id WHERE j.job_type='deg.find_markers.v1' AND j.analysis_object_id=$1 AND j.status='completed' AND a.artifact_type='deg_markers' ORDER BY j.created_at",[selection.analysisObjectId])).rows;
  for(const [index,artifact] of markers.entries()){
    const file=path.join(work,'storage',...artifact.storage_uri.split('/'));
    assert.equal(digest(file),artifact.checksum_sha256);
    fs.copyFileSync(file,path.join(output,`selected-markers-${index+1}.csv`));
  }
  fs.writeFileSync(path.join(output,'app-marker-receipts.json'),JSON.stringify(markers.map(({id,parameters_json,checksum_sha256})=>({id,parameters_json,checksum_sha256})),null,2));
  for(const file of ['preregistered.json','preregistered.sha256','truth.csv'])fs.copyFileSync(path.join(work,'reference',file),path.join(output,'reference-'+file));
  const transcript=fs.readFileSync(path.join(output,'app-transcript.jsonl'),'utf8');
  const identifiers=['H1975','H2228','HCC827','Tian','CellBench','sc_mixology','s41592-019-0425-8'];
  const leaked=identifiers.filter(value=>transcript.includes(value));
  fs.writeFileSync(path.join(output,'blinding-audit.json'),JSON.stringify({frozenReferenceHashVerified:true,lockedConclusionHashVerified:true,checkpointHashVerified:true,publicationIdentifiersScanned:identifiers,publicationIdentifiersFound:leaked,appResponsesContainNoScannedIdentifiers:leaked.length===0,referenceFrozenAt:JSON.parse(fs.readFileSync(path.join(work,'reference/preregistered.json'))).frozen_before_agent_start,selectionLockedAt:selection.lockedAt,evaluationCollectionAt:new Date().toISOString(),limits:'Procedural fresh-context blinding; not an adversarial filesystem isolation or guarantee against pretrained recognition.'},null,2));
  console.log('Locked selection collected; frozen reference and checkpoint hashes verified. Scanned identifier leaks:',leaked.length);
}finally{await db.close();}
