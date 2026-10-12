import { apiUrl } from '../api';
import { isExecutionTargetError, withExecutionTarget } from '../runtime/executionTarget';

const base=projectId=>`/api/private-r-kernels/${encodeURIComponent(projectId)}`;
const receiptBytes=16*1024;
async function readReceipt(response) {
  const invalid=()=>Object.assign(new Error('The exact private R receipt could not be confirmed. Inspect this request again before continuing.'),{status:response.status,code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});
  if(Number(response.headers?.get('content-length'))>receiptBytes)throw invalid();
  let source='';
  if(response.body?.getReader){
    const reader=response.body.getReader(); const decoder=new TextDecoder();let size=0;
    try {for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>receiptBytes)throw invalid();source+=decoder.decode(part.value,{stream:true});}source+=decoder.decode();}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    finally {reader.releaseLock();}
  } else {source=await response.text();if(new TextEncoder().encode(source).byteLength>receiptBytes)throw invalid();}
  try{return JSON.parse(source);}catch{throw invalid();}
}
async function request(path, {method='GET',body,signal,receipt=false}={}) {
  const controller=receipt?new AbortController():null;
  const abort=()=>controller?.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  let timer;const deadline=receipt?new Promise((_,reject)=>{timer=setTimeout(()=>{abort();reject(Object.assign(new Error('The exact private R receipt could not be confirmed within 10 seconds. Inspect this request again before continuing.'),{code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'}));},10000);}):null;
  const action=()=>withExecutionTarget(async () => {
  let response;
  try {response=await fetch(apiUrl(path),{method,credentials:'include',signal:controller?.signal||signal,...(receipt?{cache:'no-store'}:{}),headers:{'X-Traceomics-Csrf':'1',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
  catch(error){if(error.name==='AbortError'||isExecutionTargetError(error))throw error;throw Object.assign(new Error('The private R connection ended before completion was confirmed. Refresh the session status before running another command.'),{code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});}
  let value;try{value=await(receipt?readReceipt(response):response.json());}catch{
    if(!response.ok)throw Object.assign(new Error(response.status===401?'Sign in again to inspect your private R session.':response.status===403?'Private R access is no longer available.':'The private R request could not be confirmed. Refresh session status before continuing.'),{status:response.status,code:[401,403].includes(response.status)?'PRIVATE_KERNEL_ACCESS_REQUIRED':'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});
    throw Object.assign(new Error('The private R response could not be read. Refresh the session status before continuing.'),{code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});
  }
  if(!response.ok)throw Object.assign(new Error(typeof value?.error==='string'&&value.error.length<=500?value.error:'Private R sessions are unavailable.'),{status:response.status,code:value?.code});
  return value;
  }, { mutation: method !== 'GET' });
  try{return await(deadline?Promise.race([action(),deadline]):action());}
  finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export const getPrivateRIdentity=signal=>request('/api/auth/installation',{signal});
export const listPrivateRKernels=(projectId,{workspaceId,limit=10,signal}={})=>request(`${base(projectId)}?${new URLSearchParams({limit:String(limit),...(workspaceId?{workspaceId}:{})})}`,{signal});
export const startPrivateRKernel=(projectId,input,signal)=>request(base(projectId),{method:'POST',body:input,signal});
export const getPrivateRKernel=(projectId,kernelId,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}`,{signal});
export const executePrivateRKernel=(projectId,kernelId,input,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/executions`,{method:'POST',body:input,signal});
export const listPrivateRExecutions=(projectId,kernelId,{limit=30,before,signal}={})=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/executions?${new URLSearchParams({limit:String(limit),...(before?{before:String(before)}:{})})}`,{signal});
export const getPrivateRExecution=(projectId,kernelId,executionId,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/executions/${encodeURIComponent(executionId)}`,{signal});
export const stopPrivateRKernel=(projectId,kernelId,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/stop`,{method:'POST',body:{},signal});
export const interruptPrivateRKernel=(projectId,kernelId,input,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/interrupt`,{method:'POST',body:input,signal});
export const restartPrivateRKernel=(projectId,kernelId,input,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/restart`,{method:'POST',body:input,signal});
export const getPrivateRRestart=(projectId,kernelId,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/restart`,{signal});
export const publishPrivateROutput=(projectId,kernelId,input,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/publications`,{method:'POST',body:input,signal});
export const listPrivateRPublications=(projectId,kernelId,{limit=30,before,signal}={})=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/publications?${new URLSearchParams({limit:String(limit),...(before?{before:String(before)}:{})})}`,{signal});
export const getPrivateRStartSubmission=(projectId,requestId,signal)=>request(`${base(projectId)}/start-submissions/${encodeURIComponent(requestId)}`,{signal,receipt:true});
export const getPrivateRExecutionSubmission=(projectId,kernelId,requestId,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/execution-submissions/${encodeURIComponent(requestId)}`,{signal,receipt:true});
export const getPrivateRPublicationSubmission=(projectId,kernelId,requestId,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/publication-submissions/${encodeURIComponent(requestId)}`,{signal,receipt:true});
export const getPrivateRRestartSubmission=(projectId,requestId,signal)=>request(`${base(projectId)}/restart-submissions/${encodeURIComponent(requestId)}`,{signal,receipt:true});
