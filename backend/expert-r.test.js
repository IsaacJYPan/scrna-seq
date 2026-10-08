import { describe, expect, it, vi } from 'vitest';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EXPERT_R_PROFILE, validateExpertRParams, allocateExpertRBundleStorageKey,
  expertRSandboxEnabled, storedExpertRParams, sanitizeExpertRInputFilename,
  maxExpertRInputBytesForFilename, MAX_EXPERT_R_TABULAR_INPUT_BYTES,
  MAX_EXPERT_R_RDS_INPUT_BYTES,
} = require('./expertR');
const {
  ALLOWED_OUTPUT_EXTENSIONS, collectOutputs, assertFreeSpace, pathsShareFilesystem,
  ownerScriptFailureExplanation, isTrustedBrokerBindHost,
  validateExpertRuntimeIsolation, assertExpertRuntimeSecurity, reconcileExpertSandboxWorkRoot,
  writeWorkspaceManifest, workspaceRootHash,
} = require('./expertSandboxBroker');
const { expertRHandler } = require('./jobWorker');
const { createExpertSandboxClient } = require('./expertSandboxClient');
const { environmentFixture } = require('./_r-environment-test-utils');

describe('Expert R isolated job contract', () => {
  it('allows private RDS artifacts only through the bounded Expert R output bundle', () => {
    const outputExtensions = [...ALLOWED_OUTPUT_EXTENSIONS];
    expect(outputExtensions).toContain('.rds');
    expect(outputExtensions).toEqual(expect.arrayContaining(['.csv', '.tsv', '.json', '.png', '.pdf', '.svg']));
  });

  it('accepts RDS only as a larger sandbox-private input type', () => {
    expect(sanitizeExpertRInputFilename('derived analysis.RDS')).toBe('derived-analysis.rds');
    expect(maxExpertRInputBytesForFilename('metadata.csv')).toBe(MAX_EXPERT_R_TABULAR_INPUT_BYTES);
    expect(maxExpertRInputBytesForFilename('derived.rds')).toBe(MAX_EXPERT_R_RDS_INPUT_BYTES);
    expect(() => sanitizeExpertRInputFilename('script.R')).toThrow(/CSV, TSV, TXT, JSON, or RDS/i);
  });

  it('rejects an exact private-input copy even when it uses an allowed extension', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-expert-output-'));
    const checkpointBytes = Buffer.from('private-checkpoint-bytes');
    const checkpointChecksum = crypto.createHash('sha256').update(checkpointBytes).digest('hex');
    try {
      fs.writeFileSync(path.join(outputRoot, 'copy.txt'), checkpointBytes);
      await expect(collectOutputs(outputRoot, {
        forbiddenContentHashes: new Set([checkpointChecksum]),
      })).rejects.toThrow(/duplicates a private input/i);
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it('rejects admission when the configured free-space reserve cannot be met', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-expert-space-'));
    try {
      await expect(assertFreeSpace(root, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({
        code: 'SANDBOX_STORAGE_PRESSURE',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects when work and durable roots consume the same free-space pool', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-expert-device-'));
    const child = path.join(root, 'durable');
    fs.mkdirSync(child);
    try {
      expect(await pathsShareFilesystem(root, child)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows the broker to bind only on loopback', () => {
    expect(isTrustedBrokerBindHost('127.0.0.1')).toBe(true);
    expect(isTrustedBrokerBindHost('localhost')).toBe(true);
    expect(isTrustedBrokerBindHost('::1')).toBe(true);
    expect(isTrustedBrokerBindHost('0.0.0.0')).toBe(false);
    expect(isTrustedBrokerBindHost('192.168.1.10')).toBe(false);
    expect(isTrustedBrokerBindHost('broker.internal')).toBe(false);
  });

  it('fails closed on the system Docker socket in production', () => {
    expect(() => validateExpertRuntimeIsolation({
      NODE_ENV: 'production', EXPERT_R_RUNTIME_ISOLATION: 'dedicated-rootless',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    })).toThrow(/system Docker socket/i);
    expect(validateExpertRuntimeIsolation({
      NODE_ENV: 'production', EXPERT_R_RUNTIME_ISOLATION: 'dedicated-rootless',
      DOCKER_HOST: 'unix:///run/user/10001/docker.sock',
    })).toBe(true);
    expect(validateExpertRuntimeIsolation({ NODE_ENV: 'test' })).toBe(true);
  });

  it('verifies that the dedicated production runtime is actually rootless', async () => {
    const env = {
      NODE_ENV: 'production', EXPERT_R_RUNTIME_ISOLATION: 'dedicated-rootless',
      DOCKER_HOST: 'unix:///run/user/10001/docker.sock',
    };
    await expect(assertExpertRuntimeSecurity(env, vi.fn(async () => ({
      stdout: JSON.stringify(['name=seccomp,profile=builtin']),
    })))).rejects.toThrow(/not rootless/i);
    await expect(assertExpertRuntimeSecurity(env, vi.fn(async () => ({
      stdout: JSON.stringify(['name=seccomp,profile=builtin', 'name=rootless']),
    })))).resolves.toBe(true);
  });

  it('reconciles only stale, signed Expert R workspaces and owned containers', async () => {
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-expert-reconcile-'));
    const staleCreatedAt = new Date(Date.now() - 60_000).toISOString();
    const removable = path.join(workRoot, `job_${'a'.repeat(8)}-${'b'.repeat(24)}`);
    const active = path.join(workRoot, `job_${'c'.repeat(8)}-${'d'.repeat(24)}`);
    const invalid = path.join(workRoot, `job_${'e'.repeat(8)}-${'f'.repeat(24)}`);
    const withContainer = path.join(workRoot, `job_${'1'.repeat(8)}-${'2'.repeat(24)}`);
    try {
      for (const directory of [removable, active, invalid, withContainer]) fs.mkdirSync(directory);
      await writeWorkspaceManifest(removable, workRoot, {
        jobId: `job_${'a'.repeat(8)}`, containerName: null, createdAt: staleCreatedAt,
      });
      await writeWorkspaceManifest(active, workRoot, {
        jobId: `job_${'c'.repeat(8)}`, containerName: null, createdAt: staleCreatedAt,
      });
      fs.writeFileSync(path.join(invalid, '.traceomics-expert-workspace.json'), '{}');
      const containerName = `traceomics-expert-job_${'1'.repeat(8)}-${'3'.repeat(10)}`;
      await writeWorkspaceManifest(withContainer, workRoot, {
        jobId: `job_${'1'.repeat(8)}`, containerName, createdAt: staleCreatedAt,
      });
      const runProcessImpl = vi.fn(async (command, args) => {
        expect(command).toBe('docker');
        if (args[0] === 'inspect') return { stdout: JSON.stringify({
          'org.traceomics.expert': 'true',
          'org.traceomics.expert.workspace': path.basename(withContainer),
          'org.traceomics.expert.work-root': workspaceRootHash(workRoot),
        }) };
        expect(args).toEqual(['rm', '-f', containerName]);
        return { stdout: '' };
      });
      const result = await reconcileExpertSandboxWorkRoot({
        workRoot,
        activeWorkspaces: new Set([path.basename(active)]),
        staleAfterMs: 1000,
        runProcessImpl,
      });
      expect(result).toEqual({ removed: 2, skipped: 1, invalid: 1 });
      expect(fs.existsSync(removable)).toBe(false);
      expect(fs.existsSync(withContainer)).toBe(false);
      expect(fs.existsSync(active)).toBe(true);
      expect(fs.existsSync(invalid)).toBe(true);
      expect(runProcessImpl).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it('maps untrusted R diagnostics to fixed path-free owner explanations', () => {
    expect(ownerScriptFailureExplanation({
      exitCode: 1,
      diagnostic: 'Error: C:/private/project/checkpoint.rds object secret_name not found',
    }, 'execute')).toBe('The R script referenced an object or function that is not available.');
    expect(ownerScriptFailureExplanation({ exitCode: 125, diagnostic: 'daemon rejected' }, 'execute')).toBeNull();
  });

  it('pins a package profile and bounds scripts without pretending to sanitize R code', () => {
    const script = 'write_table(data.frame(x=1), "x.csv")';
    const result = validateExpertRParams({ profileId: EXPERT_R_PROFILE.id, script });
    expect(result.params.script).toBe(script);
    expect(result.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(storedExpertRParams({ profileId: EXPERT_R_PROFILE.id, script })).toEqual({
      profileId: EXPERT_R_PROFILE.id,
      script,
      inputIds: [],
      scriptSha256: result.scriptSha256,
    });
    expect(validateExpertRParams(
      storedExpertRParams({ profileId: EXPERT_R_PROFILE.id, script }),
      { allowStoredHash: true }
    ).scriptSha256).toBe(result.scriptSha256);
    expect(() => validateExpertRParams({ profileId: EXPERT_R_PROFILE.id, script, endpoint: 'evil' })).toThrow(/Unknown parameter/);
    expect(() => validateExpertRParams({ profileId: 'latest', script })).toThrow(/profile/);
    expect(allocateExpertRBundleStorageKey('proj_abc', 'job_def'))
      .toBe('projects/proj_abc/artifacts/job_def/expert-r-outputs.tar.gz');
    expect(expertRSandboxEnabled({
      APP_DEPLOYMENT_MODE: 'private',
      EXPERT_R_ENABLED: 'true', EXPERT_R_SANDBOX_URL: 'http://broker:8090',
      EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64),
    })).toBe(false);
    expect(expertRSandboxEnabled({
      APP_DEPLOYMENT_MODE: 'private',
      EXPERT_R_ENABLED: 'true', EXPERT_R_SANDBOX_URL: 'http://127.0.0.1:8090',
      EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64),
    })).toBe(true);
    expect(() => createExpertSandboxClient({
      baseUrl: 'https://broker.example.test', token: 'a'.repeat(64),
    })).toThrow(/configuration is invalid/);
  });

  it('passes only a trusted checkpoint key to the external sandbox and records bounded outputs', async () => {
    const environment = environmentFixture('d').reference;
    const script = 'write_table(data.frame(cells=1), "summary.csv")';
    const scriptSha256 = crypto.createHash('sha256').update(script).digest('hex');
    const runExpertSandbox = vi.fn(async () => ({
      ok: true, saved: true, checksumSha256: 'a'.repeat(64), sizeBytes: 1000,
      nFiles: 1, outputBytes: 50,
      files: [{ name: 'figure.png', sizeBytes: 50, checksumSha256: 'b'.repeat(64) }],
      profileId: EXPERT_R_PROFILE.id,
      scriptSha256,
      checkpointChecksumSha256: 'c'.repeat(64),
      privateInputs: [],
      sandboxImageDigest: `sha256:${'d'.repeat(64)}`,
      resourcePolicyVersion: 'expert-r-sandbox-policy.v3',
      environment, environmentArtifact: { internalStorageKey:'projects/proj_abc/artifacts/job_def/expert-r-outputs.tar.gz.environment.json',checksumSha256:environment.manifestSha256,sizeBytes:1000 },
    }));
    const ctx = {
      job: {
        id: 'job_def', ownerUserId: 7, projectId: 'proj_abc', analysisObjectId: 'ao_abc',
        parameters: { profileId: EXPERT_R_PROFILE.id, script, scriptSha256, environment },
      },
      heartbeat: vi.fn(), getOwnedAnalysisObject: vi.fn(async () => ({ id: 'ao_abc' })),
      getHydrationCheckpoint: vi.fn(async () => ({
        analysisObjectId: 'ao_abc',
        checkpointArtifactId: 'art_checkpoint',
        internalStorageKey: 'projects/proj_abc/checkpoints/job_abc/checkpoint.rds',
        checksumSha256: 'c'.repeat(64),
        sizeBytes: 2000,
      })),
      getExpertRPrivateInputs: vi.fn(async () => []),
      runExpertSandbox,
      completeExpertRResult: vi.fn(async () => ({
        resultObject: { id: 'ao_result' },
        bundleArtifact: { id: 'art_bundle' },
        summaryArtifact: { id: 'art_summary' },
      })),
    };
    const outcome = await expertRHandler(ctx);
    expect(runExpertSandbox).toHaveBeenCalledWith(expect.objectContaining({
      checkpointStorageKey: 'projects/proj_abc/checkpoints/job_abc/checkpoint.rds',
      checkpointChecksumSha256: 'c'.repeat(64),
      checkpointSizeBytes: 2000,
      outputStorageKey: 'projects/proj_abc/artifacts/job_def/expert-r-outputs.tar.gz',
      environment,
    }));
    expect(ctx.completeExpertRResult).toHaveBeenCalledWith(expect.objectContaining({ environmentArtifact:expect.objectContaining({ artifactType:'expert_r_environment',checksumSha256:environment.manifestSha256,metadata:{ environment } }),result:expect.objectContaining({metadata:expect.objectContaining({environment})}) }));
    expect(outcome).toMatchObject({
      resultAnalysisObjectId: 'ao_result',
      result: {
        resultAnalysisObjectId: 'ao_result',
        bundleArtifactId: 'art_bundle',
        summaryArtifactId: 'art_summary',
      },
    });
    runExpertSandbox.mockResolvedValueOnce({ ...(await runExpertSandbox.mock.results[0].value),environment:environmentFixture('a').reference });
    ctx.completeExpertRResult.mockClear();ctx.removeDurableObject=vi.fn(async()=>{});
    await expect(expertRHandler(ctx)).rejects.toMatchObject({code:'EXPERT_R_RESULT_INVALID'});
    expect(ctx.completeExpertRResult).not.toHaveBeenCalled();
    expect(ctx.removeDurableObject).toHaveBeenCalledWith('projects/proj_abc/artifacts/job_def/expert-r-outputs.tar.gz.environment.json');
  });

  it('cleans a published output bundle after every definite completion failure', async () => {
    const script = 'write_table(data.frame(x=1), "x.csv")';
    const scriptSha256 = crypto.createHash('sha256').update(script).digest('hex');
    const outputStorageKey = 'projects/proj_abc/artifacts/job_def/expert-r-outputs.tar.gz';
    const removeDurableObject = vi.fn(async () => {});
    const ctx = {
      job: {
        id: 'job_def', projectId: 'proj_abc', analysisObjectId: 'ao_abc',
        parameters: { profileId: EXPERT_R_PROFILE.id, script, scriptSha256, inputIds: [] },
      },
      heartbeat: vi.fn(),
      getOwnedAnalysisObject: vi.fn(async () => ({ id: 'ao_abc' })),
      getHydrationCheckpoint: vi.fn(async () => ({
        analysisObjectId: 'ao_abc', checkpointArtifactId: 'art_checkpoint',
        internalStorageKey: 'projects/proj_abc/checkpoints/job_abc/checkpoint.rds',
        checksumSha256: 'c'.repeat(64), sizeBytes: 2000,
      })),
      getExpertRPrivateInputs: vi.fn(async () => []),
      runExpertSandbox: vi.fn(async () => ({
        ok: true, saved: true, checksumSha256: 'a'.repeat(64), sizeBytes: 100,
        nFiles: 1, outputBytes: 10,
        files: [{ name: 'x.csv', sizeBytes: 10, checksumSha256: 'b'.repeat(64) }],
        profileId: EXPERT_R_PROFILE.id, scriptSha256,
        checkpointChecksumSha256: 'c'.repeat(64), privateInputs: [],
        sandboxImageDigest: `sha256:${'d'.repeat(64)}`,
        resourcePolicyVersion: 'expert-r-sandbox-policy.v3',
      })),
      completeExpertRResult: vi.fn(async () => { throw new Error('definite pre-commit failure'); }),
      removeDurableObject,
    };

    await expect(expertRHandler(ctx)).rejects.toThrow(/definite pre-commit failure/);
    expect(removeDurableObject).toHaveBeenCalledWith(outputStorageKey);
  });

  it('preserves a bundle when a lost COMMIT acknowledgement may already reference it', async () => {
    const script = 'write_table(data.frame(x=1), "x.csv")';
    const scriptSha256 = crypto.createHash('sha256').update(script).digest('hex');
    const indeterminate = Object.assign(new Error('commit result unknown'), {
      code: 'EXPERT_R_PUBLICATION_INDETERMINATE', completionMayHaveCommitted: true,
    });
    const removeDurableObject = vi.fn(async () => {});
    const ctx = {
      job: {
        id: 'job_def', projectId: 'proj_abc', analysisObjectId: 'ao_abc',
        parameters: { profileId: EXPERT_R_PROFILE.id, script, scriptSha256, inputIds: [] },
      },
      heartbeat: vi.fn(), getOwnedAnalysisObject: vi.fn(async () => ({ id: 'ao_abc' })),
      getHydrationCheckpoint: vi.fn(async () => ({
        analysisObjectId: 'ao_abc', checkpointArtifactId: 'art_checkpoint',
        internalStorageKey: 'projects/proj_abc/checkpoints/job_abc/checkpoint.rds',
        checksumSha256: 'c'.repeat(64), sizeBytes: 2000,
      })),
      getExpertRPrivateInputs: vi.fn(async () => []),
      runExpertSandbox: vi.fn(async () => ({
        ok: true, saved: true, checksumSha256: 'a'.repeat(64), sizeBytes: 100,
        nFiles: 1, outputBytes: 10,
        files: [{ name: 'x.csv', sizeBytes: 10, checksumSha256: 'b'.repeat(64) }],
        profileId: EXPERT_R_PROFILE.id, scriptSha256,
        checkpointChecksumSha256: 'c'.repeat(64), privateInputs: [],
        sandboxImageDigest: `sha256:${'d'.repeat(64)}`,
        resourcePolicyVersion: 'expert-r-sandbox-policy.v3',
      })),
      completeExpertRResult: vi.fn(async () => { throw indeterminate; }),
      removeDurableObject,
    };

    await expect(expertRHandler(ctx)).rejects.toBe(indeterminate);
    expect(removeDurableObject).not.toHaveBeenCalled();
  });
});
