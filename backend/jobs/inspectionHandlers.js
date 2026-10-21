// Operational checks and read-only inspection of owner-authorized R objects.

const { codedHandlerError } = require('./jobErrors');

async function genericNoopHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({ level: 'info', message: 'noop handler: no pipeline execution in this branch.' });
  return { result: { ok: true, handled: 'generic', noop: true } };
}

async function rRuntimeCheckHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message:
      'r.runtime.check handler: invoking allowlisted, metadata-only R runtime check (no pipeline execution).',
  });

  const descriptor = await ctx.runRBridgeOperation({
    job: ctx.job,
    operation: 'r.runtime.check',
    // Actor/context derived from the trusted job row, never from client input.
    actor: { userId: ctx.job.ownerUserId, projectId: ctx.job.projectId || null },
    input: ctx.job.parameters, // passed for completeness; the bridge IGNORES it (server-derived).
    claimContext: { workerId: ctx.workerId },
    logger: ctx.logger,
    callR: ctx.callR,
  });

  const artifact = await ctx.createArtifact({
    artifactType: descriptor.artifactType, // 'r_runtime_check'
    name: descriptor.name,
    description: descriptor.description,
    storageKind: descriptor.storageKind, // 'metadata_only'
    metadata: descriptor.metadata,
  });

  await ctx.log({
    level: 'info',
    message: `r.runtime.check handler: recorded metadata-only artifact ${artifact.id} (operational inspection, not a scientific output).`,
  });

  // No result analysis object / checkpoint: this is a non-mutating inspection.
  return {
    result: {
      ok: true,
      handled: 'r.runtime.check',
      operation: 'r.runtime.check',
      artifactId: artifact.id,
    },
  };
}

async function rObjectInspectHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message:
      'r.object.inspect handler: validating object ownership before any R contact (read-only inspection, no pipeline execution).',
  });

  const job = ctx.job;
  const objectId = job.analysisObjectId;

  // 1. The job MUST reference an analysis object. Fail safely BEFORE any R contact.
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError(
      'R_OBJECT_CONTEXT_REQUIRED',
      'Inspection job is missing its analysis object.'
    );
  }

  // 2. CENTRAL GATE: only the live-R object owner (the job creator) may inspect.
  //    The worker-only resolver binds the lookup to this job's valid claim and exact
  //    project scope without re-reading membership after claim. Uses a 404-style
  //    message so we never reveal another user's object exists.
  if (typeof ctx.getOwnedAnalysisObject !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  const ownedObject = await ctx.getOwnedAnalysisObject();
  if (!ownedObject || ownedObject.id !== objectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }

  // 3. Derive the R state key (X-Object-ID) SERVER-SIDE from the verified owner +
  //    object id. Never client-provided. Injected by the server so deriveRStateKey
  //    stays the single source of truth (no client controls the user-prefix).
  if (typeof ctx.deriveRObjectStateKey !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  const stateKey = ctx.deriveRObjectStateKey(job.ownerUserId, objectId);
  if (typeof stateKey !== 'string' || stateKey === '') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  const descriptor = await ctx.runRBridgeOperation({
    job,
    operation: 'r.object.inspect',
    actor: { userId: job.ownerUserId, projectId: job.projectId || null },
    // SERVER-DERIVED object context: the bridge reads object id/state key only from
    // here, never from job parameters / client input.
    objectContext: { objectId, stateKey },
    input: job.parameters, // passed for completeness; the bridge IGNORES it for routing.
    claimContext: { workerId: ctx.workerId },
    logger: ctx.logger,
    callR: ctx.callR,
  });

  const artifact = await ctx.createArtifact({
    artifactType: descriptor.artifactType, // 'r_object_inspection'
    // Associate the artifact with the inspected object (defaults to the job's own
    // analysis object, which is already same-scope) — metadata link only, not access.
    name: descriptor.name,
    description: descriptor.description,
    storageKind: descriptor.storageKind, // 'metadata_only'
    metadata: descriptor.metadata,
  });

  await ctx.log({
    level: 'info',
    message: `r.object.inspect handler: recorded metadata-only artifact ${artifact.id} (read-only inspection, not a scientific output).`,
  });

  // No result analysis object / checkpoint: this is a non-mutating inspection.
  return {
    result: {
      ok: true,
      handled: 'r.object.inspect',
      operation: 'r.object.inspect',
      artifactId: artifact.id,
    },
  };
}

module.exports = {
  genericNoopHandler,
  rRuntimeCheckHandler,
  rObjectInspectHandler,
};
