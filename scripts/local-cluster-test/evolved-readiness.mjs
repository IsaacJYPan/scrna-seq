import {createRequire} from 'node:module';import crypto from 'node:crypto';const require=createRequire(import.meta.url);
// Exercise the production shared-storage challenge and package-capability probe.
export function readinessGate(storageRoot){
 const {ensureStorageProbe}=require('../../backend/workerRuntime'),runtime=require('../../backend/rRuntime');
 const probe=ensureStorageProbe(storageRoot),config=runtime.resolveRRuntimeConfig({...process.env,R_RUNTIME_MODE:'external'});
 // The fixture runs exactly one synchronous R process. Forward the same
 // authenticated singleton barrier evidence used by production workerRuntime.
 return async()=>{const result=await runtime.probeWorkerRReadiness(config,{storageProbeNonce:probe.nonce});return {ready:true,capabilities:result.capabilities,recoveryBarrierSafe:true,rRuntimeInstanceHash:typeof result.runtime_session_id==='string'?crypto.createHash('sha256').update(result.runtime_session_id).digest('hex'):null};};
}
