// Run Expert R in the isolated sandbox and publish its validated output bundle.

const {
  validateExpertRParams,
  allocateExpertRBundleStorageKey,
  MAX_EXPERT_R_OUTPUT_BYTES,
  MAX_EXPERT_R_BUNDLE_BYTES,
  EXPERT_R_RESOURCE_POLICY_VERSION,
} = require('../expertR');
const { assertEnvironmentMatches, MAX_ENVIRONMENT_BYTES } = require('../rEnvironment');
const { codedHandlerError } = require('./jobErrors');

async function expertRHandler(ctx) {
  await ctx.heartbeat();
  if (ctx.runWorkflow) {
    const workflow = await ctx.runWorkflow(ctx);
    if (workflow) return workflow;
  }
  const job = ctx.job;
  const { params, scriptSha256 } = validateExpertRParams(job.parameters, { allowStoredHash: true });
  const ownedObject = await ctx.getOwnedAnalysisObject();
  if (!ownedObject || ownedObject.id !== job.analysisObjectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  if (typeof ctx.runExpertSandbox !== 'function') {
    throw codedHandlerError('EXPERT_R_UNAVAILABLE', 'Expert R sandbox is unavailable.');
  }
  const checkpoint = await ctx.getHydrationCheckpoint();
  if (
    !checkpoint ||
    checkpoint.analysisObjectId !== job.analysisObjectId ||
    typeof checkpoint.internalStorageKey !== 'string' ||
    typeof checkpoint.checkpointArtifactId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(String(checkpoint.checksumSha256 || '')) ||
    !Number.isSafeInteger(checkpoint.sizeBytes) ||
    checkpoint.sizeBytes < 0
  ) {
    throw codedHandlerError('NO_CHECKPOINT_ARTIFACT', 'Expert R requires a durable checkpoint.');
  }
  if (typeof ctx.getExpertRPrivateInputs !== 'function') {
    throw codedHandlerError('EXPERT_R_UNAVAILABLE', 'Expert R private inputs are unavailable.');
  }
  const privateInputs = await ctx.getExpertRPrivateInputs();
  const privateInputProvenance = privateInputs.map((input) => ({
    id: input.id,
    sizeBytes: input.sizeBytes,
    checksumSha256: input.checksumSha256,
  }));
  const outputStorageKey = allocateExpertRBundleStorageKey(job.projectId, job.id);
  const sandbox = await ctx.runExpertSandbox({
    jobId: job.id,
    projectId: job.projectId,
    profileId: params.profileId,
    ...(params.environment ? { environment: params.environment } : {}),
    script: params.script,
    checkpointStorageKey: checkpoint.internalStorageKey,
    checkpointChecksumSha256: checkpoint.checksumSha256,
    checkpointSizeBytes: checkpoint.sizeBytes,
    privateInputs: privateInputs.map((input) => ({
      id: input.id,
      originalFilename: input.originalFilename,
      internalStorageKey: input.internalStorageKey,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256,
    })),
    outputStorageKey,
  });
  const outputFiles = Array.isArray(sandbox?.files) ? sandbox.files : [];
  const environmentStorageKey = `${outputStorageKey}.environment.json`;
  let validEnvironment = !params.environment;
  if (params.environment) {
    try {
      assertEnvironmentMatches(params.environment, sandbox?.environment);
      validEnvironment =
        sandbox.environment.imageDigest === sandbox.sandboxImageDigest &&
        sandbox.environmentArtifact?.internalStorageKey === environmentStorageKey &&
        sandbox.environmentArtifact.checksumSha256 === params.environment.manifestSha256 &&
        Number.isSafeInteger(sandbox.environmentArtifact.sizeBytes) &&
        sandbox.environmentArtifact.sizeBytes > 0 &&
        sandbox.environmentArtifact.sizeBytes <= MAX_ENVIRONMENT_BYTES;
    } catch {
      validEnvironment = false;
    }
  }
  const validFiles =
    outputFiles.length === sandbox?.nFiles &&
    outputFiles.every(
      (file) =>
        file &&
        typeof file.name === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(file.name) &&
        !file.name.split('/').some((part) => part === '.' || part === '..' || part === '') &&
        Number.isSafeInteger(file.sizeBytes) &&
        file.sizeBytes >= 0 &&
        /^[0-9a-f]{64}$/.test(String(file.checksumSha256 || ''))
    );
  const validSandbox =
    sandbox &&
    sandbox.saved === true &&
    /^[0-9a-f]{64}$/.test(String(sandbox.checksumSha256 || '')) &&
    Number.isSafeInteger(sandbox.sizeBytes) &&
    sandbox.sizeBytes >= 0 &&
    sandbox.sizeBytes <= MAX_EXPERT_R_BUNDLE_BYTES &&
    Number.isInteger(sandbox.nFiles) &&
    sandbox.nFiles >= 0 &&
    sandbox.nFiles <= 50 &&
    Number.isSafeInteger(sandbox.outputBytes) &&
    sandbox.outputBytes >= 0 &&
    sandbox.outputBytes <= MAX_EXPERT_R_OUTPUT_BYTES &&
    outputFiles.reduce((total, file) => total + (Number(file?.sizeBytes) || 0), 0) ===
      sandbox.outputBytes &&
    validFiles &&
    sandbox.profileId === params.profileId &&
    sandbox.scriptSha256 === scriptSha256 &&
    sandbox.checkpointChecksumSha256 === checkpoint.checksumSha256 &&
    JSON.stringify(sandbox.privateInputs || []) === JSON.stringify(privateInputProvenance) &&
    /^sha256:[0-9a-f]{64}$/.test(String(sandbox.sandboxImageDigest || '')) &&
    sandbox.resourcePolicyVersion === EXPERT_R_RESOURCE_POLICY_VERSION;
  if (!validSandbox || !validEnvironment) {
    if (typeof ctx.removeDurableObject === 'function') {
      try {
        await ctx.removeDurableObject(outputStorageKey);
      } catch {
        /* validation error wins */
      }
      if (params.environment)
        try {
          await ctx.removeDurableObject(environmentStorageKey);
        } catch {
          /* validation error wins */
        }
    }
    throw codedHandlerError('EXPERT_R_RESULT_INVALID', 'Expert R sandbox output is invalid.');
  }
  const files = outputFiles.map((file) => ({
    name: file.name,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
  }));
  const provenance = {
    ...(params.environment ? { environment: params.environment } : {}),
    packageProfileId: params.profileId,
    sandboxImageDigest: sandbox.sandboxImageDigest,
    resourcePolicyVersion: sandbox.resourcePolicyVersion,
    scriptSha256,
    input: {
      analysisObjectId: job.analysisObjectId,
      checkpointArtifactId: checkpoint.checkpointArtifactId,
      checkpointChecksumSha256: checkpoint.checksumSha256,
      checkpointSizeBytes: checkpoint.sizeBytes,
      privateInputs: privateInputProvenance,
    },
  };
  let completion;
  try {
    completion = await ctx.completeExpertRResult({
      ...(params.environment
        ? {
            environmentArtifact: {
              artifactType: 'expert_r_environment',
              name: 'Exact R environment',
              description: 'Verified package lock and immutable container userspace identity.',
              storageKind: 'local_internal',
              mimeType: 'application/json',
              ...sandbox.environmentArtifact,
              metadata: { environment: params.environment },
            },
          }
        : {}),
      result: {
        objectType: 'generic',
        displayName: 'Expert R result',
        metadata: {
          analysisKind: 'expert_r',
          ...provenance,
          outputBundleChecksumSha256: sandbox.checksumSha256,
          nFiles: sandbox.nFiles,
        },
      },
      bundleArtifact: {
        artifactType: 'expert_r_bundle',
        name: 'Expert R output bundle',
        description: 'Private outputs from an ephemeral no-network Expert R sandbox.',
        storageKind: 'local_internal',
        mimeType: 'application/gzip',
        internalStorageKey: outputStorageKey,
        checksumSha256: sandbox.checksumSha256,
        sizeBytes: sandbox.sizeBytes,
        metadata: {
          nFiles: sandbox.nFiles,
          outputBytes: sandbox.outputBytes,
          ...provenance,
          files,
        },
      },
      summaryArtifact: {
        artifactType: 'expert_r_summary',
        name: 'Expert R execution summary',
        description: 'Bounded manifest for isolated Expert R outputs.',
        storageKind: 'metadata_only',
        metadata: {
          ...provenance,
          outputBundleChecksumSha256: sandbox.checksumSha256,
          outputBundleSizeBytes: sandbox.sizeBytes,
          nFiles: sandbox.nFiles,
          files,
          downloadable: false,
        },
      },
    });
  } catch (error) {
    // Definite pre-commit failures leave an orphaned bundle and are safe to
    // remove. A lost COMMIT acknowledgement is different: the database may
    // already reference this exact object, so preserve it for operator repair.
    if (
      error?.completionMayHaveCommitted !== true &&
      typeof ctx.removeDurableObject === 'function'
    ) {
      try {
        await ctx.removeDurableObject(outputStorageKey);
      } catch {
        /* original publication error wins */
      }
      if (params.environment)
        try {
          await ctx.removeDurableObject(environmentStorageKey);
        } catch {
          /* original publication error wins */
        }
    }
    throw error;
  }
  return {
    resultAnalysisObjectId: completion.resultObject.id,
    result: {
      ok: true,
      handled: 'expert.r.v1',
      resultAnalysisObjectId: completion.resultObject.id,
      bundleArtifactId: completion.bundleArtifact.id,
      summaryArtifactId: completion.summaryArtifact.id,
    },
  };
}

module.exports = {
  expertRHandler,
};
