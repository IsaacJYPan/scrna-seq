import { describe, expect, it } from 'vitest';
import { artifactBytesLabel, readPrivateRArtifactPolicy } from './privateRArtifactPolicy';

const policy = {
  schemaVersion: 1, maxOutputBytes: 512 * 1024 ** 2, maxInputFileBytes: 512 * 1024 ** 2,
  maxInputTotalBytes: 1024 ** 3, managedQuotaBytes: 5 * 1024 ** 3,
  diskReserveBytes: 1024 ** 3, transferTimeoutSeconds: 900,
};

describe('private R artifact policy display', () => {
  it('uses only explicit versioned server limits without copying extra private data', () => {
    expect(readPrivateRArtifactPolicy({ ...policy, path: '/host/storage' })).toEqual({
      maxOutputBytes: policy.maxOutputBytes, maxInputFileBytes: policy.maxInputFileBytes,
      maxInputTotalBytes: policy.maxInputTotalBytes, managedQuotaBytes: policy.managedQuotaBytes,
      diskReserveBytes: policy.diskReserveBytes, transferTimeoutSeconds: 900,
    });
  });

  it('keeps missing, partial, unsupported and invalid limits unknown', () => {
    for (const value of [undefined, {}, { ...policy, schemaVersion: 2 },
      { ...policy, maxOutputBytes: null }, { ...policy, maxOutputBytes: '536870912' },
      { ...policy, diskReserveBytes: -1 }, { ...policy, transferTimeoutSeconds: Infinity },
      { ...policy, managedQuotaBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...policy, maxOutputBytes: 64 * 1024 ** 3 + 1 },
      { ...policy, transferTimeoutSeconds: 3601 },
      { ...policy, maxInputFileBytes: policy.maxInputTotalBytes + 1 },
      Object.assign([], policy)]) {
      expect(readPrivateRArtifactPolicy(value)).toBeNull();
    }
    expect(readPrivateRArtifactPolicy({ ...policy, maxOutputBytes: 64 * 1024 ** 3,
      transferTimeoutSeconds: 3600 })).toMatchObject({ maxOutputBytes: 64 * 1024 ** 3,
      transferTimeoutSeconds: 3600 });
  });

  it('labels full saved sizes without claiming an invalid size is zero', () => {
    expect(artifactBytesLabel(0)).toBe('0 bytes');
    expect(artifactBytesLabel(224 * 1024 ** 2)).toBe('224.0 MiB');
    expect(artifactBytesLabel(5 * 1024 ** 3)).toBe('5.0 GiB');
    for (const value of [undefined, -1, NaN, '2048']) expect(artifactBytesLabel(value)).toBe('Size unavailable');
  });
});
