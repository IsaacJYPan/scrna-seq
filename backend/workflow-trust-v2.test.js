import {describe,it,expect,afterEach} from 'vitest';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const trust=require('./workflowTrust/manifest');
const {currentReleases}=require('./workflowTrust/catalog');
const {createRunInspection}=require('./automation/inspection');
const {tableCell}=require('./automation/inspection');
const original=process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE;
let temporary;
afterEach(()=>{if(original===undefined)delete process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE;else process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE=original;if(temporary){fs.unlinkSync(temporary);temporary=null;}});
const profile={schema:'traceomics.workflow-runtime.v1',imageDigest:'sha256:'+'a'.repeat(64),rVersion:'4.5.3',packages:[{name:'Seurat',version:'5.5.1'}]};
function configure(){temporary=path.join(os.tmpdir(),'workflow-trust-'+require('node:crypto').randomUUID()+'.json');fs.writeFileSync(temporary,JSON.stringify(profile));process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE=temporary;}
describe('approved workflow trust v2',()=>{
 it('covers the actual shared R core, runner and bridge/dependency sources',()=>{const files=trust.trustManifest().source.map(f=>f.path);for(const file of ['r-backend/lib/seuratPipelineCore.R','r-backend/hpc-runner.R','backend/rBridge/completionReceipts.js','backend/workflowTrust/manifest.js','package-lock.json'])expect(files).toContain(file);expect(files.some(f=>f.includes('.test.'))).toBe(false);});
 it('rejects a missing runtime and changed image or package inventory',()=>{expect(()=>trust.assertRuntime(null,profile)).toThrow();expect(()=>trust.assertRuntime(profile,{...profile,imageDigest:'sha256:'+'b'.repeat(64)})).toThrow();expect(()=>trust.assertRuntime(profile,{...profile,packages:[{name:'Seurat',version:'5.4.0'}]})).toThrow();});
 it('checks actual runtime and R source before an agent handler can execute',async()=>{configure();const release=currentReleases()[0];const plan={release:{id:release.id,digest:release.digest},trust:release.definition.trust};const db={getAgentRunTrustForJob:async()=>plan};const source=plan.trust.source.filter(f=>f.path.startsWith('r-backend/')&&f.path.endsWith('.R'));await expect(trust.verifyJobTrust(db,{id:'job_x',agentRun:true},async()=>({status:200,body:{...profile,source}}))).resolves.toBeUndefined();await expect(trust.verifyJobTrust(db,{id:'job_x',agentRun:true},async()=>({status:200,body:{...profile,source:[]}}))).rejects.toMatchObject({code:'WORKFLOW_SOURCE_CHANGED'});await expect(trust.verifyJobTrust(db,{id:'job_x',agentRun:true},async()=>({status:503}))).rejects.toMatchObject({code:'WORKFLOW_RUNTIME_UNAVAILABLE'});});
 it('changes release identity when the approved runtime changes',()=>{configure();const before=currentReleases()[0].digest;fs.writeFileSync(temporary,JSON.stringify({...profile,imageDigest:'sha256:'+'b'.repeat(64)}));expect(currentReleases()[0].digest).not.toBe(before);});
 it('rejects edited source in a process that loaded the prior bytes',()=>{
   const read=fs.readFileSync;try{fs.readFileSync=function(file,...args){const bytes=read.call(this,file,...args);return String(file).endsWith('package-lock.json')?Buffer.concat([Buffer.from(bytes),Buffer.from(' ')]):bytes;};expect(()=>trust.trustManifest()).toThrow('changed after server startup');}finally{fs.readFileSync=read;}
 });
 it('accepts the shipped R service inventory without build-only and HPC files',async()=>{
   configure();const release=currentReleases()[0],plan={release:{id:release.id,digest:release.digest},trust:release.definition.trust};
   const roots=new Set(['plumber.R','run.R','expert-runner.R','private-kernel-init.R','generate-demo-template.R']);
   const source=plan.trust.source.filter(f=>f.path.startsWith('r-backend/lib/')||roots.has(f.path.replace(/^r-backend\//,'')));
   await expect(trust.verifyJobTrust({getAgentRunTrustForJob:async()=>plan},{id:'job_a',agentRun:true},async()=>({status:200,body:{...profile,source}}))).resolves.toBeUndefined();
 });
 it('attests the Slurm runtime and passes the exact pin to the staged runner',async()=>{
   configure();const release=currentReleases()[0],plan={release:{id:release.id,digest:release.digest},trust:release.definition.trust};const job={id:'job_a',executionTarget:'slurm',agentRun:true};
   await trust.verifyJobTrust({getAgentRunTrustForJob:async()=>plan},job,()=>{throw new Error('must not contact local R');},{attestRuntime:async()=>profile});expect(job.workflowTrust).toEqual(plan.trust);
   await expect(trust.verifyJobTrust({getAgentRunTrustForJob:async()=>plan},job,null,{attestRuntime:async()=>({...profile,rVersion:'4.4.0'})})).rejects.toMatchObject({code:'WORKFLOW_RUNTIME_MISMATCH'});
 });
 it('pins condition design and rejects later metadata mutations',async()=>{
   const design=require('./workflowTrust/design');let batch='batch1';const db={query:async sql=>({rows:sql.includes('FROM condition_contrasts')?[{id:'contrast_a',status:'valid'}]:Array.from({length:4},(_,i)=>({sample_id:String(i),batch}))})};
   const pinned=await design.pinDesign(db,'p','ao','contrast_a');const plan={projectId:'p',inputs:{analysisObjectId:'ao'},design:pinned};await expect(design.verifyDesign(db,plan)).resolves.toBeUndefined();batch='changed';await expect(design.verifyDesign(db,plan)).rejects.toMatchObject({code:'WORKFLOW_DESIGN_CHANGED'});
 });
});
describe('agent scientific inspection boundaries',()=>{
 const actor={delegation:{id:'dlg_1',projectId:'p1',disclosureProfile:'labels'}};
 it('refuses quarantined results before reading artifacts',async()=>{const inspect=createRunInspection({db:{query:()=>{throw new Error('must not read');}},admission:{getRunForAgent:async()=>({state:'quarantined'})}});await expect(inspect.inspect(actor,'run_x')).rejects.toMatchObject({code:'RESULT_NOT_READY'});});
 it('requires explicit labels disclosure even with inspection capability',async()=>{const inspect=createRunInspection({db:{},admission:{}});await expect(inspect.inspect({...actor,delegation:{...actor.delegation,disclosureProfile:'identifiers'}},'run_x')).rejects.toMatchObject({code:'DISCLOSURE_DENIED'});});
 it('does not expose arbitrary metadata keys or storage paths',async()=>{const inspect=createRunInspection({admission:{getRunForAgent:async()=>({state:'candidate_ready',resultAnalysisObjectId:'ao_1'})},db:{query:async sql=>({rows:sql.includes('FROM analysis_objects')?[{metadata_json:{summary:{nCells:42,secretPath:'/server/private',diagnostics:{qc_after:{nCount_RNA:{median:2}}}}}}]:[]})}});const result=await inspect.inspect(actor,'run_x');expect(result.summary.nCells).toBe(42);expect(JSON.stringify(result)).not.toContain('/server/private');});
 it('never reads an artifact outside the run/delegation query',async()=>{let query;const inspect=createRunInspection({admission:{getRunForAgent:async()=>({state:'candidate_ready'})},db:{query:async(sql,args)=>{query={sql,args};return {rows:[]};}}});await expect(inspect.artifact(actor,'run_x','art_abcd')).rejects.toMatchObject({code:'NOT_FOUND'});expect(query.sql).toContain('ar.delegation_id=$2');expect(query.args).toEqual(['run_x','dlg_1','art_abcd','p1']);});
 it('retains bounded leading-edge gene lists without exposing absolute paths',()=>{
   const genes=Array.from({length:100},(_,i)=>'GENE'+i).join('/');expect(genes.length).toBeGreaterThan(200);expect(tableCell(genes)).toBe(genes);
   for(const value of ['/server/private','C:\\private\\file','https://example.invalid/secret','../private','gene/../private','a'.repeat(2001),'gene\nsecret'])expect(tableCell(value)).toBeNull();
 });
 it('fails closed for agent jobs and never asks for trust on human jobs',async()=>{
   configure();
   const plan={release:{id:'rel_x',digest:'x'}};
   const noAccessor={query:async()=>({rows:[{}]})};
   await expect(trust.verifyJobTrust(noAccessor,{id:'job_x'},async()=>({status:200}))).rejects.toMatchObject({code:'WORKFLOW_TRUST_UNAVAILABLE'});
   await expect(trust.verifyJobTrust({},{id:'job_x',agentRun:true},async()=>({status:200}))).rejects.toMatchObject({code:'WORKFLOW_TRUST_UNAVAILABLE'});
   await expect(trust.verifyJobTrust({getAgentRunTrustForJob:async()=>null},{id:'job_x',agentRun:true},async()=>({status:200}))).rejects.toMatchObject({code:'WORKFLOW_TRUST_MISSING'});
   await expect(trust.verifyJobTrust({getAgentRunTrustForJob:async()=>plan},{id:'job_x'},async()=>({status:200}))).rejects.toMatchObject({code:'WORKFLOW_TRUST_UNAVAILABLE'});
   let asked=false;
   await expect(trust.verifyJobTrust({getAgentRunTrustForJob:async()=>{asked=true;return null;}},{id:'job_h',agentRun:false},async()=>({status:200}))).resolves.toBeUndefined();
   expect(asked).toBe(false);
   await expect(trust.verifyJobTrust({query:async()=>({rows:[]})},{id:'job_h'},async()=>({status:200}))).resolves.toBeUndefined();
 });
});
