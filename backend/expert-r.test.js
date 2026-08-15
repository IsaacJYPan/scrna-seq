import { describe, expect, it, vi } from 'vitest';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EXPERT_R_PROFILE, validateExpertRParams, allocateExpertRBundleStorageKey,
  expertRSandboxEnabled, storedExpertRParams,
} = require('./expertR');
const {
  ALLOWED_OUTPUT_EXTENSIONS, collectOutputs, assertFreeSpace, pathsShareFilesystem,
  ownerScriptFailureExplanation, isTrustedBrokerBindHost,
} = require('./expertSandboxBroker');
const { expertRHandler } = require('./jobWorker');
const { createExpertSandboxClient } = require('./expertSandboxClient');

describe('Expert R isolated job contract', () => {
  it('does not allow the private checkpoint format in downloadable Expert R outputs', () => {
    const outputExtensions = [...ALLOWED_OUTPUT_EXTENSIONS];
    expect(outputExtensions).not.toContain('.rds');
    expect(outputExtensions).toEqual(expect.arrayContaining(['.csv', '.tsv', '.json', '.png', '.pdf', '.svg']));
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
      resourcePolicyVersion: 'expert-r-sandbox-policy.v2',
    }));
    const ctx = {
      job: {
        id: 'job_def', ownerUserId: 7, projectId: 'proj_abc', analysisObjectId: 'ao_abc',
        parameters: { profileId: EXPERT_R_PROFILE.id, script, scriptSha256 },
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
    }));
    expect(outcome).toMatchObject({
      resultAnalysisObjectId: 'ao_result',
      result: {
        resultAnalysisObjectId: 'ao_result',
        bundleArtifactId: 'art_bundle',
        summaryArtifactId: 'art_summary',
      },
    });
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
        resourcePolicyVersion: 'expert-r-sandbox-policy.v2',
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
        resourcePolicyVersion: 'expert-r-sandbox-policy.v2',
      })),
      completeExpertRResult: vi.fn(async () => { throw indeterminate; }),
      removeDurableObject,
    };

    await expect(expertRHandler(ctx)).rejects.toBe(indeterminate);
    expect(removeDurableObject).not.toHaveBeenCalled();
  });
});
