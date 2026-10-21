import { WORKFLOW_RESTORATION_SCHEMA } from '../../shared/workflowSnapshot.mjs';

const instanceId = /^wfi_[a-f0-9]{24}$/;
const generation = value => Number.isSafeInteger(value) && value >= 0 && value < 2147483647;
export function validateWorkflowRestoration(result, snapshot, request) {
  const receipt = result?.restoration, current = result?.currentInstance;
  const fail = () => { throw Object.assign(new Error('The saved workflow open could not be confirmed. Check the original request again.'), { code: 'INVALID_WORKFLOW_RESTORATION_RESPONSE' }); };
  if (!receipt || receipt.schema !== WORKFLOW_RESTORATION_SCHEMA || receipt.requestId !== request.requestId
      || receipt.snapshotId !== snapshot.id || receipt.sha256 !== request.sha256 || receipt.sha256 !== snapshot.sha256
      || receipt.analysisObjectId !== snapshot.analysisObjectId || receipt.packageDigest !== snapshot.packageDigest
      || !instanceId.test(receipt.instanceId) || request.expectedInstance && receipt.instanceId !== request.expectedInstance.id || !generation(receipt.generation)
      || receipt.generation !== (request.expectedInstance?.generation ?? snapshot.state?.generation) + 1
      || typeof result.replayed !== 'boolean' || typeof result.canEditWorking !== 'boolean'
      || current === null && !result.replayed) fail();
  if (current !== null && (!current || current.id !== receipt.instanceId || current.projectId !== snapshot.projectId
      || current.analysisObjectId !== snapshot.analysisObjectId || current.packageDigest !== snapshot.packageDigest
      || !generation(current.state?.generation) || current.state.generation < receipt.generation
      || !Array.isArray(current.package?.tabs) || !current.package.tabs.length
      || current.package.tabs.some(tab => !tab || typeof tab.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(tab.id)))) fail();
  return result;
}
