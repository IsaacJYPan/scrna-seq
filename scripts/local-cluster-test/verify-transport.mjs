import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const execute=promisify(execFile);
const work=path.resolve('scratch/local-cluster-test');
const output=path.resolve('exports/paper-reproduction');
Object.assign(process.env,{
  DATABASE_URL:'postgres://postgres:local-fixture-only@127.0.0.1:45432/tro_mcp_test',
  SLURM_SSH_TARGET:'root@127.0.0.1',SLURM_SSH_PORT:'43222',
  SLURM_SSH_KEY:path.join(work,'client'),SLURM_SSH_KNOWN_HOSTS:path.join(work,'known_hosts'),
  SLURM_REMOTE_ROOT:'/cluster',SLURM_POLL_SECONDS:'1',SLURM_RSCRIPT:'/usr/local/bin/Rscript'
});
const db=require('../../backend/pgDatabase');
const {createSlurmExecutor}=require('../../backend/executors/slurm');
const source=JSON.parse(fs.readFileSync(path.join(output,'local-cluster-report.json')));
const report={checks:[],scope:'Real SSH transport against one completed disposable PBMC3k job. Remote scheduler states and checkpoint corruption are intentionally injected; no new scientific jobs.'};
const remote=async command=>(await execute('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${process.env.SLURM_SSH_KNOWN_HOSTS}`,'-o','IdentitiesOnly=yes','-i',process.env.SLURM_SSH_KEY,'-p','43222','root@127.0.0.1',command],{windowsHide:true})).stdout;
let dir,id;
try{
  const row=(await db.query('SELECT * FROM hpc_dispatches WHERE job_id=(SELECT job_id FROM agent_runs WHERE id=$1)',[source.runId])).rows[0];
  dir=row.remote_dir;id=row.slurm_job_id;
  assert.match(dir,/^\/cluster\/job_[0-9a-f]+$/);assert.match(id,/^\d+$/);
  const executor=createSlurmExecutor({db});
  const local=path.join(work,'transport-recovered.rds');
  const args={jobId:row.job_id,inputs:[],params:{},resources:{cpus:1,memoryMiB:8192,maxWallSeconds:3600},checkpointPath:local,heartbeat:async()=>{},log:async()=>{},isCanceled:async()=>false};
  const before=await remote('cat /scheduler/submissions');
  const recovered=await executor.runSeurat(args);
  assert.equal(recovered.slurmJobId,id);
  assert.equal(await remote('cat /scheduler/submissions'),before);
  report.checks.push('Reattaches to completed dispatch and collects checkpoint without another sbatch');
  await remote(`cp ${dir}/output/checkpoint.rds ${dir}/output/checkpoint.test-backup; printf CORRUPT >> ${dir}/output/checkpoint.rds`);
  try{
    await assert.rejects(executor.runSeurat(args),{code:'CHECKPOINT_INTEGRITY_FAILED'});
    assert.equal(fs.existsSync(local),false);
    report.checks.push('Rejects corrupted SCP checkpoint and removes unverified local bytes');
  }finally{await remote(`mv ${dir}/output/checkpoint.test-backup ${dir}/output/checkpoint.rds`);}
  await remote(`echo FAILED > /scheduler/${id}`);
  await assert.rejects(executor.runSeurat(args),{code:'SLURM_JOB_FAILED'});
  report.checks.push('Remote FAILED state propagates as SLURM_JOB_FAILED');
  await remote(`echo RUNNING > /scheduler/${id}`);
  await assert.rejects(executor.runSeurat({...args,isCanceled:async()=>true}),{code:'JOB_CANCELED'});
  assert.ok((await remote('cat /scheduler/cancellations')).split(/\s+/).includes(id));
  report.checks.push('Cancellation sends actual SSH scancel and reports JOB_CANCELED');
  report.status='passed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;console.error(error.stack);}
finally{
  if(id){await remote(`echo COMPLETED > /scheduler/${id}`);await createSlurmExecutor({db}).runSeurat({jobId:dir.split('/').pop(),inputs:[],params:{},resources:{},checkpointPath:path.join(work,'transport-restored.rds'),heartbeat:async()=>{},log:async()=>{},isCanceled:async()=>false});}
  fs.writeFileSync(path.join(output,'transport-checks.json'),JSON.stringify(report,null,2));
  await db.close();
  console.log(JSON.stringify(report,null,2));
}
