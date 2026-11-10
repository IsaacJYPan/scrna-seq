// JSON-RPC stdio transport to the unchanged project MCP server. No app API,
// researcher session, R evaluation, result export, or database access fallback.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const [name='help',json='{}']=process.argv.slice(2);
const access=JSON.parse(fs.readFileSync('scratch/mcp-study/mcp-access.json','utf8'));
const child=spawn(process.execPath,['cli/traceomics-mcp.mjs'],{env:{...process.env,TRACEOMICS_URL:access.origin,TRACEOMICS_AGENT_TOKEN_FILE:access.tokenFile},stdio:['pipe','pipe','pipe'],windowsHide:true});
const reply=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(new Error('MCP transport timed out'));},30000);
  child.on('error',reject);child.stderr.on('data',data=>process.stderr.write(data));
  createInterface({input:child.stdout}).on('line',line=>{
    const message=JSON.parse(line);
    if(message.id===1){child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:name==='help'?'tools/list':'tools/call',params:name==='help'?{}:{name,arguments:JSON.parse(json)}})+'\n');}
    if(message.id===2){clearTimeout(timer);child.stdin.end();resolve(message);}
  });
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'mcp-only-study-client',version:'1'}}})+'\n');
});
fs.appendFileSync('exports/mcp-study/agent-transcript.jsonl',JSON.stringify({time:new Date().toISOString(),name,args:JSON.parse(json),reply})+'\n');
console.log(JSON.stringify(reply,null,2));
if(reply.error||reply.result?.isError)process.exitCode=1;
