'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const {environmentFixture}=require('./_r-environment-test-utils');
const {EXPERT_R_RESOURCE_POLICY_VERSION}=require('./expertR');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=','base64');
async function startKernelFixtureBroker() {
  const {manifest,reference}=environmentFixture(); const sessions=new Map(); const calls=[]; const hooks={}; const token=crypto.randomBytes(32).toString('hex');
  const resources={memoryBytes:1024**3,cpuLimit:1,pidsLimit:128,idleTimeoutSeconds:900,maxLifetimeSeconds:14400}; const target={kind:'service',id:'private-r-kernel',generation:crypto.randomBytes(32).toString('hex')};
  const descriptor=session=>({ok:true,kernelId:session.kernelId,generation:session.generation,status:session.status,environment:reference,resources,target,startedAt:session.startedAt,expiresAt:session.expiresAt,...(session.lastExecution?{lastExecution:session.lastExecution}:{})});
  const broker=http.createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end('{}');return;}
    res.setHeader('Content-Type','application/json');
    if(req.url==='/environment'){res.end(JSON.stringify(manifest));return;}
    if(req.url==='/capabilities'){res.end(JSON.stringify({status:'ok',profileId:reference.profileId,resourcePolicyVersion:EXPERT_R_RESOURCE_POLICY_VERSION,sandboxImageDigest:reference.imageDigest,environment:reference,persistentKernel:true,persistentKernelInterrupt:hooks.interruptEnabled!==false,persistentKernelPublications:hooks.publicationsEnabled!==false,persistentKernelStreamedPublications:hooks.streamedPublicationsEnabled===true,...(hooks.streamedPublicationsEnabled===true?{privateRArtifactPolicy:require('./privateRArtifactPolicy').getPrivateRArtifactPolicy()}: {})}));return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);let input;try{input=JSON.parse(Buffer.concat(chunks).toString());}catch{res.writeHead(400);res.end('{}');return;}
    calls.push({path:req.url,input});const kernelId=input.kernelId||req.url.split('/')[2];let session=sessions.get(kernelId);
    const send=value=>res.end(JSON.stringify(value));const failure=(code,status=409)=>{res.writeHead(status);send({ok:false,code,message:'Private fixture rejection'});};
    if(req.url==='/kernels/start'){
      if(session)return session.status==='stopped'?failure('PRIVATE_KERNEL_STOPPED'):send(descriptor(session));
      session={kernelId,generation:crypto.randomBytes(32).toString('hex'),ownerUserId:String(input.ownerUserId),projectId:input.projectId,workspaceId:input.workspaceId,status:'ready',startedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+14400000).toISOString(),order:0,n:0};sessions.set(kernelId,session);await hooks.beforeStartResponse?.(session,input);send(descriptor(session));return;
    }
    if(!session){if(req.url.endsWith('/stop')){session={kernelId,generation:input.generation||crypto.randomBytes(32).toString('hex'),status:'stopped',ownerUserId:String(input.ownerUserId),projectId:input.projectId,workspaceId:input.workspaceId};sessions.set(kernelId,session);send({ok:true,kernelId,generation:session.generation,status:'stopped'});return;}failure('PRIVATE_KERNEL_NOT_FOUND',404);return;}
    if(session.ownerUserId!==String(input.ownerUserId)||session.projectId!==input.projectId||session.workspaceId!==input.workspaceId||input.generation&&input.generation!==session.generation){failure('PRIVATE_KERNEL_NOT_FOUND',404);return;}
    if(req.url.endsWith('/stop')){session.status='stopped';if(session.releaseExecution){session.controlledResult={ok:true,kernelId,generation:session.generation,executionId:session.lastExecution.id,order:session.lastExecution.order,status:'unknown'};session.releaseExecution();}await hooks.beforeStopResponse?.(session,req);if(req.socket.destroyed)return;send({ok:true,kernelId,generation:session.generation,status:'stopped',stoppedAt:new Date().toISOString()});return;}
    if(req.url.endsWith('/inspect')){send(descriptor(session));return;}
    if(req.url.endsWith('/interrupt')){
      const latest=session.lastExecution;
      if(!input.generation || !latest || latest.id!==input.executionId || latest.order!==input.order || !/^[a-f0-9-]{36}$/i.test(input.requestId||'')){failure('PRIVATE_KERNEL_INTERRUPT_INVALID');return;}
      if(hooks.interruptEnabled===false){failure('PRIVATE_KERNEL_INTERRUPT_UNAVAILABLE',503);return;}
      let result=latest.result,outcome='already-completed';
      if(session.status==='executing') {
        result={ok:true,kernelId,generation:session.generation,executionId:input.executionId,order:input.order,status:'failed',stdout:'',warnings:[],error:{code:'PRIVATE_KERNEL_INTERRUPTED',message:'The command was interrupted.'},interrupted:true,tables:[],figures:[],truncated:false,startedAt:latest.startedAt||new Date().toISOString(),completedAt:new Date().toISOString()};
        session.lastExecution={id:input.executionId,order:input.order,status:'failed',result};session.controlledResult=result;session.status='ready';outcome='interrupted';session.releaseExecution?.();
      }
      const response={ok:true,kernelId,generation:session.generation,executionId:input.executionId,order:input.order,outcome,status:session.status,idleConfirmed:session.status==='ready',...(result?{execution:result}:{})};
      await hooks.beforeInterruptResponse?.(session,response,req);if(req.socket.destroyed)return;send(response);return;
    }
    if(req.url.endsWith('/export-status')){const receipt=session.exports?.get(input.publicationId);if(!receipt){failure('PRIVATE_KERNEL_PUBLICATION_NOT_FOUND',404);return;}await hooks.beforeExportStatus?.(receipt,input);send(receipt);return;}
    if(req.url.endsWith('/export')){
      if(session.status==='stopped'){failure('PRIVATE_KERNEL_STOPPED');return;}if(session.status!=='ready'){failure('PRIVATE_KERNEL_BUSY');return;}
      if(input.order!==session.order+1){failure('PRIVATE_KERNEL_ORDER_INVALID');return;}
      const {validatePrivateKernelExportRequest}=require('./privateKernelExports');
      try{validatePrivateKernelExportRequest(input,{projectId:session.projectId,generation:session.generation});}catch{failure('PRIVATE_KERNEL_PUBLICATION_INVALID',400);return;}
      session.exports ||= new Map();session.order=input.order;session.status='executing';const startedAt=new Date().toISOString();session.lastExecution={id:input.executionId,order:input.order,status:'executing',startedAt};session.controlledResult=null;
      const identity={ok:true,kernelId,generation:session.generation,publicationId:input.publicationId,executionId:input.executionId,order:input.order};session.exports.set(input.publicationId,{...identity,status:'executing'});
      await hooks.beforeExportStorage?.(session,input);
      const failed=input.binding==='missing_fixture'||session.controlledResult?.status==='failed';
      const result=session.controlledResult||{ok:true,kernelId,generation:session.generation,executionId:input.executionId,order:input.order,status:failed?'failed':'completed',stdout:'',warnings:[],error:failed?{message:'Fixture binding unavailable'}:null,tables:[],figures:[],truncated:false,startedAt,completedAt:new Date().toISOString()};
      let file;
      if(!failed){const storage=require('./storage');const provider=storage.createLocalStorageProvider();const exported=await hooks.exportFile?.(input,session,provider);let evidence=exported;if(!exported){const bytes=await hooks.exportBytes?.(input,session)||Buffer.from(input.type==='table'?'sample,condition\nS1,treated\n':'Opaque fixture RDS bytes');await require('node:fs/promises').writeFile(provider.prepareWrite(input.internalStorageKey),bytes,{flag:'wx',mode:0o600});evidence={checksumSha256:crypto.createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length};}file={type:input.type,format:input.type==='table'?'csv':'rds',internalStorageKey:input.internalStorageKey,...evidence};}
      const receipt={...identity,status:result.status,result,...(file?{file}:{})};session.exports.set(input.publicationId,receipt);session.status='ready';session.lastExecution={id:input.executionId,order:input.order,status:result.status,result};await hooks.beforeExportResponse?.(session,receipt,req);if(req.socket.destroyed)return;send(receipt);return;
    }
    if(req.url.endsWith('/execute')){
      if(session.status==='stopped'){failure('PRIVATE_KERNEL_STOPPED');return;}if(input.order!==session.order+1){failure('PRIVATE_KERNEL_ORDER_INVALID');return;}
      session.order=input.order;session.status='executing';const startedAt=new Date().toISOString();session.lastExecution={id:input.executionId,order:input.order,status:'executing',startedAt};session.controlledResult=null;
      if(input.source==='interrupt_fixture'){await new Promise(resolve=>{session.releaseExecution=resolve;hooks.beforeExecutePending?.(session,input);});if(session.controlledResult){await hooks.beforeExecuteResponse?.(session,session.controlledResult);send(session.controlledResult);return;}}
      if(input.source==='disconnect_fixture'){session.status='unknown';req.socket.destroy();return;}
      if(input.source==='delay_fixture')await new Promise(resolve=>setTimeout(resolve,100));
      const assignment=/n\s*<-\s*(\d+)/.exec(input.source);if(assignment)session.n=Number(assignment[1]);if(input.source.trim()==='n + 1')session.n+=1;
      const failed=input.source.includes('stop(');const result={ok:true,kernelId,generation:session.generation,executionId:input.executionId,order:input.order,status:failed?'failed':'completed',stdout:failed?'':`[1] ${session.n}\n`,warnings:input.source.includes('warning(')?['Fixture warning']:[],error:failed?{message:'Fixture R error'}:null,tables:input.source.includes('data.frame')?[{name:'R table',columns:['cells','condition'],rows:[[session.n,'treated']],truncated:false}]:[],figures:input.source.includes('plot(')?[{mimeType:'image/png',data:png.toString('base64'),width:1,height:1,sha256:crypto.createHash('sha256').update(png).digest('hex')}]:[],truncated:false,startedAt,completedAt:new Date().toISOString()};session.status='ready';session.lastExecution={id:input.executionId,order:input.order,status:result.status,result};await hooks.beforeExecuteResponse?.(session,result);send(result);return;
    }
    failure('PRIVATE_KERNEL_NOT_FOUND',404);
  });
  await new Promise(resolve=>broker.listen(0,'127.0.0.1',resolve));
  return {url:'http://127.0.0.1:'+broker.address().port,token,manifest,reference,sessions,calls,hooks,resources,target,close:()=>new Promise(resolve=>{broker.closeAllConnections();broker.close(resolve);})};
}
module.exports={startKernelFixtureBroker,png};
