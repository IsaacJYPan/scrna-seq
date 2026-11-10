// Independent evaluator. Invoke only AFTER the blinded author explicitly freezes.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';
if(!process.argv.includes('--author-frozen'))throw new Error('Explicit author freeze is required; manuscript existence alone is not completion.');
const require=createRequire(import.meta.url),out=path.resolve('exports/methods-benchmark'),blind=path.join(out,'blinded'),work=path.resolve('scratch/methods-benchmark');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const files=['manuscript.md','final-annotation.json','decisions.md','run-registry.json','review-burden.md'];
const hashes=Object.fromEntries(files.map(file=>[file,hash(fs.readFileSync(path.join(blind,file)))]));
const mediaHashes=Object.fromEntries(fs.readdirSync(blind).filter(file=>/^art_[a-f0-9]+\.(png|svg|pdf)$/.test(file)).map(file=>[file,hash(fs.readFileSync(path.join(blind,file)))]));
const annotation=JSON.parse(fs.readFileSync(path.join(blind,'final-annotation.json')));
if(!/^run_[a-f0-9]{24}$/.test(annotation.selectedRunId)||!annotation.clusterToPopulation||Array.isArray(annotation.clusterToPopulation))throw new Error('Malformed final annotation.');
const referenceHash=hash(fs.readFileSync(path.join(out,'reference/preregistered.json')));
if(referenceHash!=='ae2f24fbff911c6962d60e27f7ce6da981730569ce1cb8e565f19995ffc177da')throw new Error('Frozen reference changed.');
const referenceLabelsHash=hash(fs.readFileSync(path.join(out,'reference/celltypes.tsv')));
if(referenceLabelsHash!==JSON.parse(fs.readFileSync(path.join(out,'reference/preregistered.json'))).referenceLabelsSha256)throw new Error('Frozen researcher labels changed.');
const sponsorManifestHash=hash(fs.readFileSync(path.join(work,'sponsor-inputs.json')));
process.env.DATABASE_URL='postgres://postgres:local-fixture-only@127.0.0.1:45434/tro_methods_test';process.env.STORAGE_ROOT=path.join(work,'storage');process.env.VAULT_ROOT=path.join(work,'vault');
const db=require('../../backend/pgDatabase'),provider=require('../../backend/storage').createLocalStorageProvider();
try {
 const {rows}=await db.query("SELECT ar.*,j.status,j.result_analysis_object_id,a.storage_uri,a.checksum_sha256,a.size_bytes,ep.canonical_json FROM agent_runs ar JOIN jobs j ON j.id=ar.job_id JOIN execution_plans ep ON ep.id=ar.plan_id JOIN job_artifacts a ON a.job_id=j.id AND a.artifact_type='checkpoint' WHERE ar.id=$1",[annotation.selectedRunId]);
 if(rows.length!==1||rows[0].status!=='completed')throw new Error('Selected final checkpoint is not completed.');
 const selected=rows[0],opened=await provider.openVerifiedRead(selected.storage_uri,{checksumSha256:selected.checksum_sha256,sizeBytes:Number(selected.size_bytes)});await opened.handle.close();
 const transcript=fs.readFileSync(path.join(blind,'mcp-transcript.jsonl'),'utf8');const forbidden=[/\bDing\b/i,/GSE132044/i,/SCP424/i,/scumi/i,/s41587-020-0465-8/i];
 const transcriptRows=transcript.trim().split('\n').map(JSON.parse);const transcriptReplies=transcriptRows.map(r=>JSON.stringify(r.reply)).join('\n');
 const leaks=forbidden.filter(pattern=>pattern.test(transcriptReplies)).map(String);
 const authorText=files.map(file=>fs.readFileSync(path.join(blind,file),'utf8')).join('\n');const authorIdentifiers=forbidden.filter(pattern=>pattern.test(authorText)).map(String);
 const projectIds=[...new Set([selected.project_id,...transcriptRows.map(r=>r.args?.projectId).filter(id=>typeof id==='string'&&/^proj_[a-f0-9]+$/.test(id))])];
 const runs=await db.query('SELECT ar.id,ar.project_id,ar.study_id,ar.job_id,ar.plan_digest,j.status,j.job_type,j.parameters_json,j.error_json,j.created_at,j.completed_at,j.result_analysis_object_id,ep.canonical_json FROM agent_runs ar JOIN jobs j ON j.id=ar.job_id JOIN execution_plans ep ON ep.id=ar.plan_id WHERE ar.project_id=ANY($1::text[]) ORDER BY ar.created_at',[projectIds]);
 const artifacts=await db.query('SELECT a.id,a.job_id,a.artifact_type,a.storage_uri,a.checksum_sha256,a.size_bytes,a.mime_type,a.metadata_json FROM job_artifacts a JOIN agent_runs ar ON ar.job_id=a.job_id WHERE ar.project_id=ANY($1::text[]) ORDER BY a.created_at,a.id',[projectIds]);
 const snapshot={time:new Date().toISOString(),authorExplicitlyFrozen:true,files:hashes,mediaFiles:mediaHashes,referenceSha256:referenceHash,referenceLabelsSha256:referenceLabelsHash,sponsorManifestSha256:sponsorManifestHash,libraryIdentityCheckSha256:hash(fs.readFileSync(path.join(out,'reference/library-identity-check.json'))),transportSha256:hash(fs.readFileSync('scripts/local-cluster-test/methods-mcp-client.mjs')),selectedRunId:annotation.selectedRunId,checkpointSha256:selected.checksum_sha256,checkpointBytes:Number(selected.size_bytes),selectedPlan:JSON.parse(selected.canonical_json),paperIdentifiersInMcpReplies:leaks,paperIdentifiersInAuthorOutputs:authorIdentifiers,instructionBasedBlindingOnly:true};
 fs.writeFileSync(path.join(out,'author-freeze-lock.json'),JSON.stringify(snapshot,null,2));
 fs.writeFileSync(path.join(out,'completed-run-audit.json'),JSON.stringify(runs.rows,null,2));
 fs.writeFileSync(path.join(out,'artifact-audit.json'),JSON.stringify(artifacts.rows,null,2));
 const methodCounts={};for(const row of transcriptRows)methodCounts[row.name]=(methodCounts[row.name]||0)+1;
 const submissionIntervals=[];let since=[];for(const row of transcriptRows){if(row.name==='submit_run'){submissionIntervals.push({time:row.time,planId:row.args?.planId,inspectionCallsSincePreviousSubmission:since.filter(x=>['inspect_run','preview_artifact','get_run_results'].includes(x.name)).map(x=>({time:x.time,method:x.name,runId:x.args?.runId,artifactId:x.args?.artifactId,table:x.args?.table}))});since=[];}else since.push(row);}
 fs.writeFileSync(path.join(out,'mcp-process-audit.json'),JSON.stringify({basis:'Original logged MCP requests; inspections include failed replies and repeated previews, so counts alone do not establish scientific adequacy',methodCounts,submissionIntervals,transcriptSha256:hash(Buffer.from(transcript)),note:'The analyst used an unchanged stdio transport. Instruction-based restrictions are not an adversarial OS sandbox; this audit does not prove absence of pretrained dataset recognition.'},null,2));
 fs.writeFileSync(path.join(work,'evaluation-input.json'),JSON.stringify({checkpoint:'/fixture/storage/'+selected.storage_uri,annotation:'/output/blinded/final-annotation.json',sourceManifest:'/fixture/sponsor-inputs.json',reference:'/output/reference/celltypes.tsv'}));
 console.log(JSON.stringify({selectedRunId:annotation.selectedRunId,checkpointBytes:Number(selected.size_bytes),frozenFiles:files.length,paperIdentifierLeaks:leaks.length}));
} finally {await db.close();}
