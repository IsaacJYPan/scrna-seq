// Parent-only fixture provisioning. No human session is given to the analyst.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
const require=createRequire(import.meta.url);
const work=path.resolve('scratch/mcp-study');
Object.assign(process.env,{DATABASE_URL:'postgres://postgres:local-fixture-only@127.0.0.1:45432/tro_mcp_study_test',NODE_ENV:'test',DISABLE_RATE_LIMIT:'true',SESSION_SECRET:crypto.randomBytes(32).toString('hex'),STORAGE_ROOT:path.join(work,'storage'),VAULT_ROOT:path.join(work,'vault'),R_BACKEND_URL:'http://127.0.0.1:48000',R_API_TOKEN:'local-test-r-token-0123456789abcdef',API_TOKEN:'local-test-r-token-0123456789abcdef',SLURM_SSH_TARGET:'root@127.0.0.1',SLURM_SSH_PORT:'43222',SLURM_SSH_KEY:path.resolve('scratch/local-cluster-test/client'),SLURM_SSH_KNOWN_HOSTS:path.resolve('scratch/local-cluster-test/known_hosts'),SLURM_REMOTE_ROOT:'/cluster',SLURM_RSCRIPT:'/usr/local/bin/Rscript',SLURM_POLL_SECONDS:'1'});
const db=require('../../backend/pgDatabase');
const storage=require('../../backend/storage');
const {startServer,createUserWithToken,api}=require('../../backend/_http-test-utils');
const {createJobWorker}=require('../../backend/jobWorker');
const {currentReleases}=require('../../backend/workflowTrust/catalog');
const server=await startServer();
const sponsor=await createUserWithToken({email:`mcp-study-${Date.now()}@example.invalid`,displayName:'Local fixture sponsor'});
const org=await db.createOrganization('Local MCP validation',sponsor.user.id);
const project=await db.createProject(org.id,'Anonymous sample A MCP study',sponsor.user.id);
const ds=await db.createDatasetForProject(sponsor.user.id,project.id,{fileType:'tenx_h5',originalFilename:'sample-A.h5'});
const provider=storage.createLocalStorageProvider();
const key=storage.projectStorageFileKey(project.id,'datasets',ds.id,'sample-A.h5');
fs.mkdirSync(path.dirname(provider.resolveKey(key)),{recursive:true});fs.copyFileSync(path.resolve('scratch/blind-study/sample-A.h5'),provider.resolveKey(key));
const bytes=fs.readFileSync(provider.resolveKey(key));
await db.markDatasetUploaded(project.id,ds.id,{internalStorageKey:key,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),fileSizeBytes:bytes.length});
const base=`/api/projects/${project.id}`;
async function post(route,body){const reply=await api(server,base+route,{method:'POST',token:sponsor.token,body});if(reply.status>=300)throw new Error(JSON.stringify(reply.data));return reply.data;}
const releases=currentReleases();
for(const release of releases)await post(`/workflow-releases/${release.id}/approve`,{digest:release.digest,note:'Disposable MCP test; no scientific endorsement'});
const source=await post('/studies',{name:'Exploratory population structure',releaseId:releases.find(r=>r.key==='seurat-qc-cluster').id,datasetIds:[ds.id],executionTarget:'slurm',maxTrials:3,maxOutstandingRuns:1,fixedParameters:{seed:42,minFeatures:0,applyQcFilter:false,variableFeatures:2000,pcaDims:20,clusterDims:15,umapDims:15},variations:{clusterResolution:[0.25,0.5,0.8]}});
const delegation=await post('/agent-delegations',{agentName:'MCP-only analyst',capabilities:['metadata.read','results.read','proposal.create','workflow.plan','workflow.executeApproved','run.cancelOwn'],disclosureProfile:'labels'});
const tokenFile=path.join(work,'agent-token');fs.writeFileSync(tokenFile,delegation.credential.token,{mode:0o600});
fs.writeFileSync(path.join(work,'mcp-access.json'),JSON.stringify({origin:`http://127.0.0.1:${server.address().port}`,tokenFile}));
const worker=createJobWorker({db,storageProvider:provider,deriveRObjectStateKey:require('../../backend/rStateKeys').deriveRObjectStateKey,logger:console});worker.start();
console.log('MCP fixture ready. Agent token only; call get_context first.');
createInterface({input:process.stdin}).on('line',async line=>{
  try{
    const command=JSON.parse(line);
    if(command.action==='prepare_markers'){
      await post(`/agent-runs/${command.runId}/accept`,{expectedAcceptedRunId:null,note:'Synthetic sponsor handoff for MCP interface test, not scientific validation'});
      const follow=await post('/studies',{name:'Markers on selected exploratory result',releaseId:releases.find(r=>r.key==='seurat-markers').id,sourceStudyId:source.id,maxTrials:1,maxOutstandingRuns:1,fixedParameters:{randomSeed:42,topMarkersPerCluster:20}});
      console.log('MARKER_STUDY_READY '+follow.id);
    }else if(command.action==='shutdown'){
      await worker.stop();await new Promise(resolve=>server.close(resolve));await db.close();process.exit(0);
    }
  }catch(error){console.error('FIXTURE_CONTROL_ERROR '+error.message);}
});
