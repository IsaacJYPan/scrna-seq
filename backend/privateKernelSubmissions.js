'use strict';

const c = require('./privateKernelContract');
const READ_ROLES = ['owner','admin','analyst','viewer'];
const time = value => value == null ? null : new Date(value).toISOString();
const missing = () => c.kernelError('PRIVATE_KERNEL_SUBMISSION_NOT_FOUND','The exact private R submission was not found.',404);
const terminal = status => ['completed','failed'].includes(status);

// UUID recovery reads immutable admission identity only. It deliberately does
// not inspect the broker, reconcile a kernel, or infer a different submission.
function createPrivateKernelSubmissionService(db) {
  async function get(kind,userId,projectId,requestId,kernelId) {
    if (!c.UUID.test(requestId || '')) throw c.kernelError('PRIVATE_KERNEL_REQUEST_INVALID','A valid private R request identifier is required.');
    if (['execution','publication'].includes(kind) && !c.KERNEL_ID.test(kernelId || '')) throw missing();
    await db.requireProjectRole(userId,projectId,READ_ROLES);
    let query,parameters;
    if (kind === 'start') {
      query = `SELECT id AS kernel_id,project_id,workspace_id,request_id,start_sha256 AS request_hash,
        runtime_generation AS generation,status,created_at,updated_at,stopped_at AS completed_at
        FROM private_r_kernels WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3
        AND restarted_from_kernel_id IS NULL`;
      parameters = [projectId,userId,requestId];
    } else if (kind === 'execution') {
      query = `SELECT e.id AS execution_id,e.kernel_id,e.project_id,k.workspace_id,e.request_id,
        e.source_sha256 AS request_hash,e.kernel_generation AS generation,e.execution_order AS command_order,
        e.status,e.created_at,e.updated_at,e.completed_at
        FROM private_r_executions e JOIN private_r_kernels k ON k.id=e.kernel_id
        WHERE e.project_id=$1 AND e.owner_user_id=$2 AND e.request_id=$3 AND e.kernel_id=$4
        AND k.project_id=$1 AND k.owner_user_id=$2`;
      parameters = [projectId,userId,requestId,kernelId];
    } else if (kind === 'publication') {
      query = `SELECT p.id AS publication_id,p.kernel_id,p.project_id,k.workspace_id,p.request_id,
        p.request_sha256 AS request_hash,p.kernel_generation AS generation,p.kernel_order AS command_order,
        p.source_execution_id,CASE WHEN p.status='completed' THEN p.version_id ELSE NULL END AS version_id,
        p.status,p.created_at,p.updated_at,p.completed_at
        FROM private_r_publications p JOIN private_r_kernels k ON k.id=p.kernel_id
        WHERE p.project_id=$1 AND p.owner_user_id=$2 AND p.request_id=$3 AND p.kernel_id=$4
        AND k.project_id=$1 AND k.owner_user_id=$2`;
      parameters = [projectId,userId,requestId,kernelId];
    } else if (kind === 'restart') {
      query = `SELECT r.id AS restart_id,r.kernel_id,r.project_id,k.workspace_id,r.request_id,
        r.request_sha256 AS request_hash,r.kernel_generation AS generation,r.status,r.created_at,r.updated_at,r.completed_at,
        child.id AS replacement_kernel_id
        FROM private_r_kernel_restarts r JOIN private_r_kernels k ON k.id=r.kernel_id
        LEFT JOIN private_r_kernels child ON child.id=r.replacement_kernel_id
          AND child.project_id=r.project_id AND child.owner_user_id=r.owner_user_id
          AND child.restarted_from_kernel_id=r.kernel_id
        WHERE r.project_id=$1 AND r.owner_user_id=$2 AND r.request_id=$3
        AND k.project_id=$1 AND k.owner_user_id=$2`;
      parameters = [projectId,userId,requestId];
    } else throw c.kernelError('PRIVATE_KERNEL_REQUEST_INVALID','Select a supported private R submission kind.');
    const row = (await db.query(query,parameters)).rows[0];
    await db.requireProjectRole(userId,projectId,READ_ROLES);
    if (!row) throw missing();
    const receipt = {
      schema:'traceomics.private-r-submission.v1',kind,projectId:row.project_id,workspaceId:row.workspace_id,
      requestId:row.request_id,requestHash:row.request_hash,kernelId:row.kernel_id,generation:row.generation,
      status:row.status,completionKnown:kind==='start'?Boolean(row.generation)||['stopped','failed'].includes(row.status):terminal(row.status),
      createdAt:time(row.created_at),updatedAt:time(row.updated_at),completedAt:time(row.completed_at),
      ...(kind==='execution'?{executionId:row.execution_id,order:Number(row.command_order)}:{}),
      ...(kind==='publication'?{publicationId:row.publication_id,sourceExecutionId:row.source_execution_id,order:Number(row.command_order),versionId:row.version_id}:{}),
      ...(kind==='restart'?{restartId:row.restart_id,replacementKernelId:row.replacement_kernel_id}:{}),
    };
    if (Buffer.byteLength(JSON.stringify(receipt)) > 16384) throw c.kernelError('PRIVATE_KERNEL_SUBMISSION_INVALID','The private R submission receipt exceeds its bounded metadata limit.',500);
    return receipt;
  }
  return {get};
}
module.exports={createPrivateKernelSubmissionService};
