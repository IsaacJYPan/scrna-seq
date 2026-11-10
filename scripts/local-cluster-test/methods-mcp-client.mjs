// Analyst transport: only JSON-RPC stdio to the project's MCP, with logged receipts.
// Returned media are saved verbatim; no scientific computation happens here.
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
const [name='help',json='{}']=process.argv.slice(2),args=JSON.parse(json),out=path.resolve('exports/methods-benchmark/blinded'),access=JSON.parse(fs.readFileSync('scratch/methods-benchmark/blind-mcp-access.json','utf8'));
const child=spawn(process.execPath,['cli/traceomics-mcp.mjs'],{env:{...process.env,TRACEOMICS_URL:access.origin,TRACEOMICS_AGENT_TOKEN_FILE:access.tokenFile},stdio:['pipe','pipe','pipe'],windowsHide:true});
const reply=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('MCP transport timed out'));},45000);child.on('error',reject);child.stderr.on('data',d=>process.stderr.write(d));createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.id===1)child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:name==='help'?'tools/list':'tools/call',params:name==='help'?{}:{name,arguments:args}})+'\n');if(m.id===2){clearTimeout(timer);child.stdin.end();resolve(m);}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'blinded-client',version:'2'}}})+'\n');});
fs.appendFileSync(path.join(out,'mcp-transcript.jsonl'),JSON.stringify({time:new Date().toISOString(),name,args,reply})+'\n');
if(reply.result?.tools)console.log(JSON.stringify(reply.result.tools,null,2));
function displayText(text){
 let value;try{value=JSON.parse(text);}catch{return text;}
 // Display only: exact original MCP bytes were logged above. Scientific
 // parameters/results are unchanged; repeated source/package inventories are
 // represented by their already-bound release digest and inventory counts.
 if(['create_plan','get_plan'].includes(name)&&value.plan?.trust){const trust=value.plan.trust;value.plan.trust={schema:trust.schema,sourceFileCount:trust.source?.length,sourceAndRuntimeBoundByReleaseDigest:value.plan.release?.digest,runtime:trust.runtime?{imageDigest:trust.runtime.imageDigest,rVersion:trust.runtime.rVersion,packageCount:trust.runtime.packages?.length}:null};}
 if(Array.isArray(value.rows)){const {rows,...metadata}=value;return JSON.stringify(metadata)+'\n'+rows.map(row=>JSON.stringify(row)).join('\n');}
 return JSON.stringify(value,null,2);
}
for(const block of reply.result?.content||[]){if(block.type==='image'||(block.type==='resource'&&block.resource?.blob)){const mime=block.mimeType||block.resource.mimeType,extension={'image/png':'png','image/svg+xml':'svg','application/pdf':'pdf'}[mime];if(extension){const file=path.join(out,args.artifactId+'.'+extension);fs.writeFileSync(file,Buffer.from(block.data||block.resource.blob,'base64'));console.log('MCP media: '+file);}}else if(block.type==='text')console.log(displayText(block.text));}
if(reply.error||reply.result?.isError){console.error(JSON.stringify(reply.error||reply.result));process.exitCode=1;}
