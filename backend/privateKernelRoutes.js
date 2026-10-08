'use strict';
const express=require('express');
const {createPrivateKernelService}=require('./privateKernelService');
function privateKernelRoutes({db,provider,requireAuth,serviceOptions}) {
  const router=express.Router(); const service=createPrivateKernelService(db,provider,serviceOptions); router.use(requireAuth);
  router.use(express.json({limit:'80kb',inflate:false}));
  router.use((error,req,res,next)=>{if(error.type==='entity.too.large'||error.status===413)return res.status(413).json({code:'PRIVATE_KERNEL_REQUEST_TOO_LARGE',error:'Private R requests must fit the bounded source and input limits.'});if(error.type==='entity.parse.failed'||error.status===415)return res.status(error.status===415?415:400).json({code:'PRIVATE_KERNEL_REQUEST_INVALID',error:'The private R request must contain valid uncompressed JSON.'});next(error);});
  const route=callback=>async(req,res)=>{res.setHeader('Cache-Control','private, no-store');try{res.json(await callback(req));}catch(error){const status=error.status||(/NOT_FOUND/.test(error.code||'')?404:['FORBIDDEN','PROJECT_ROLE_REQUIRED'].includes(error.code)?403:error.code==='R_ENVIRONMENT_MISMATCH'?409:error.code==='R_ENVIRONMENT_INVALID'?400:error.code==='R_ENVIRONMENT_UNAVAILABLE'?503:500); const safe=error.publicSafeHandlerError===true||status<500;res.status(status).json({error:safe?error.message:'Private R sessions are unavailable. Check the session state before continuing.',...(safe&&error.code?{code:error.code}:{})});}};
  router.get('/:projectId',route(req=>service.list(req.user.id,req.params.projectId,req.query)));
  router.post('/:projectId',route(req=>service.start(req.user.id,req.params.projectId,req.body)));
  router.get('/:projectId/:kernelId',route(req=>service.get(req.user.id,req.params.projectId,req.params.kernelId)));
  router.post('/:projectId/:kernelId/stop',route(req=>service.stop(req.user.id,req.params.projectId,req.params.kernelId)));
  router.post('/:projectId/:kernelId/executions',route(req=>service.execute(req.user.id,req.params.projectId,req.params.kernelId,req.body)));
  router.get('/:projectId/:kernelId/executions',route(req=>service.executions(req.user.id,req.params.projectId,req.params.kernelId,req.query)));
  router.get('/:projectId/:kernelId/executions/:executionId',route(req=>service.execution(req.user.id,req.params.projectId,req.params.kernelId,req.params.executionId)));
  return router;
}
module.exports={privateKernelRoutes};
