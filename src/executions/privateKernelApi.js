import { apiUrl } from '../api';

const base=projectId=>`/api/private-r-kernels/${encodeURIComponent(projectId)}`;
async function request(path, {method='GET',body,signal}={}) {
  let response;
  try {response=await fetch(apiUrl(path),{method,credentials:'include',signal,headers:{'X-Traceomics-Csrf':'1',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
  catch(error){if(error.name==='AbortError')throw error;throw Object.assign(new Error('The private R connection ended before completion was confirmed. Refresh the session status before running another command.'),{code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});}
  let value;try{value=await response.json();}catch{throw Object.assign(new Error('The private R response could not be read. Refresh the session status before continuing.'),{code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});}
  if(!response.ok)throw Object.assign(new Error(typeof value?.error==='string'&&value.error.length<=500?value.error:'Private R sessions are unavailable.'),{status:response.status,code:value?.code});
  return value;
}
export const listPrivateRKernels=(projectId,{workspaceId,limit=10,signal}={})=>request(`${base(projectId)}?${new URLSearchParams({limit:String(limit),...(workspaceId?{workspaceId}:{})})}`,{signal});
export const startPrivateRKernel=(projectId,input,signal)=>request(base(projectId),{method:'POST',body:input,signal});
export const getPrivateRKernel=(projectId,kernelId,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}`,{signal});
export const executePrivateRKernel=(projectId,kernelId,input,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/executions`,{method:'POST',body:input,signal});
export const listPrivateRExecutions=(projectId,kernelId,{limit=30,before,signal}={})=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/executions?${new URLSearchParams({limit:String(limit),...(before?{before:String(before)}:{})})}`,{signal});
export const getPrivateRExecution=(projectId,kernelId,executionId,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/executions/${encodeURIComponent(executionId)}`,{signal});
export const stopPrivateRKernel=(projectId,kernelId,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/stop`,{method:'POST',body:{},signal});
export const publishPrivateROutput=(projectId,kernelId,input,signal)=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/publications`,{method:'POST',body:input,signal});
export const listPrivateRPublications=(projectId,kernelId,{limit=30,before,signal}={})=>request(`${base(projectId)}/${encodeURIComponent(kernelId)}/publications?${new URLSearchParams({limit:String(limit),...(before?{before:String(before)}:{})})}`,{signal});
