// Thin transport client only. All scientific computation runs inside the app.
// No source dataset, reference labels, paper identity, or expected outcomes are
// read by this client or included in responses.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const [command,arg='{}']=process.argv.slice(2);
if(!command||command==='help'){
  console.log(JSON.stringify({commands:{describe:'App project, dataset and input object IDs',cluster:'JSON Seurat parameters; submits app job on SSH target; maximum three runs',status:'job ID',object:'analysis object ID',artifacts:'job ID (includes app-computed marker summaries)',markers:'JSON {analysisObjectId, parameters?}; submits app marker job',table:'marker artifact ID; app download displayed as top 12 rows per cluster'},clusteringParameters:require('../../backend/seuratPipeline').SEURAT_PIPELINE_PARAM_SPEC,markerParameters:require('../../backend/degFindMarkers').DEG_FIND_MARKERS_PARAM_SPEC,analysis:'Human post-QC UMI count matrix. Supported package: installed Seurat. Suggested normalization LogNormalize; seed 42. No target population count is specified.'},null,2));process.exit(0);
}
const access=JSON.parse(fs.readFileSync('scratch/blind-study/app-access.json','utf8'));
const base=`/api/projects/${access.projectId}`;
async function request(route,body){
  const response=await fetch(access.origin+route,{method:body?'POST':'GET',headers:{Cookie:`${access.cookieName}=${encodeURIComponent(access.sessionToken)}`,Origin:'http://localhost:5173','Content-Type':'application/json','X-Traceomics-Csrf':'1'},body:body?JSON.stringify(body):undefined});
  const text=await response.text();let result;try{result=JSON.parse(text);}catch{result=text;}
  if(!response.ok)throw new Error(JSON.stringify({status:response.status,result}));return result;
}
let result;
if(command==='describe') result={projectId:access.projectId,datasetId:access.datasetId,inputObjectId:access.inputObjectId,input:await request(`${base}/analysis-objects/${access.inputObjectId}`)};
else if(command==='cluster'){
  const jobs=await request(`${base}/jobs`);const list=Array.isArray(jobs)?jobs:jobs.jobs;
  if(list.filter(j=>j.jobType==='seurat.pipeline.v1').length>=3)throw new Error('Three clustering trials have already been submitted.');
  result=await request(`${base}/jobs`,{jobType:'seurat.pipeline.v1',datasetId:access.datasetId,analysisObjectId:access.inputObjectId,executionTarget:'slurm',requestId:crypto.randomUUID(),parameters:JSON.parse(arg)});
}else if(command==='markers'){
  const p=JSON.parse(arg);result=await request(`${base}/jobs`,{jobType:'deg.find_markers.v1',analysisObjectId:p.analysisObjectId,requestId:crypto.randomUUID(),parameters:p.parameters||{randomSeed:42,topMarkersPerCluster:20}});
}else if(['status','object','artifacts','table'].includes(command)){
  if(!/^(job|ao|art)_[a-zA-Z0-9]+$/.test(arg))throw new Error('Invalid app ID.');
  const route=command==='status'?`${base}/jobs/${arg}`:command==='object'?`${base}/analysis-objects/${arg}`:command==='artifacts'?`${base}/jobs/${arg}/artifacts`:`${base}/artifacts/${arg}/download`;
  result=await request(route);
  if(command==='table'&&typeof result==='string'){
    const parse=line=>line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(x=>x.replace(/^"|"$/g,'').replace(/""/g,'"'));
    const lines=result.trim().split(/\r?\n/);const header=parse(lines.shift());const rows=lines.map(parse).map(v=>Object.fromEntries(header.map((h,i)=>[h,v[i]])));
    const groups=[...new Set(rows.map(r=>r.cluster))];
    result={totalRows:rows.length,topRowsByCluster:groups.map(group=>({cluster:group,rows:rows.filter(r=>r.cluster===group).sort((a,b)=>Number(b.avg_log2FC)-Number(a.avg_log2FC)).slice(0,12)}))};
  }
}else throw new Error('Unknown command; use help.');
fs.appendFileSync('exports/blind-study/app-transcript.jsonl',JSON.stringify({time:new Date().toISOString(),command,arg,response:result})+'\n');
console.log(JSON.stringify(result,null,2));
