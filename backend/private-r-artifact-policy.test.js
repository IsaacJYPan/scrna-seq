import { describe, expect, it } from 'vitest';
const { getPrivateRArtifactPolicy, validatePrivateRArtifactPolicy, effectivePrivateRArtifactPolicy } = require('./privateRArtifactPolicy');

describe('private R artifact admission policy', () => {
  it('provides finite disk, input, output and transfer limits', () => {
    expect(getPrivateRArtifactPolicy({})).toEqual({ schemaVersion: 1,
      maxOutputBytes: 512 * 1024 ** 2, maxInputFileBytes: 512 * 1024 ** 2,
      maxInputTotalBytes: 1024 ** 3, managedQuotaBytes: 5 * 1024 ** 3,
      diskReserveBytes: 1024 ** 3, transferTimeoutSeconds: 900 });
  });

  it.each(['0', '-1', '1.5', 'Infinity', '1e9', 'no limit', String(64 * 1024 ** 3 + 1)])('refuses an invalid output limit %s', raw => {
    expect(() => getPrivateRArtifactPolicy({ PRIVATE_R_MAX_OUTPUT_BYTES: raw })).toThrow(/PRIVATE_R_MAX_OUTPUT_BYTES/);
  });

  it('refuses an inconsistent input envelope and excessive transfer lifetime', () => {
    expect(() => getPrivateRArtifactPolicy({ PRIVATE_R_MAX_INPUT_TOTAL_BYTES: '1' })).toThrow(/PRIVATE_R_MAX_INPUT_TOTAL_BYTES/);
    expect(() => getPrivateRArtifactPolicy({ PRIVATE_R_TRANSFER_TIMEOUT_SECONDS: '3601' })).toThrow(/PRIVATE_R_TRANSFER_TIMEOUT_SECONDS/);
  });

  it('accepts bounded large limits and independent quotas', () => {
    const policy = getPrivateRArtifactPolicy({ PRIVATE_R_MAX_OUTPUT_BYTES: String(8 * 1024 ** 3),
      PRIVATE_R_MANAGED_QUOTA_BYTES: '1024' });
    expect(policy.maxOutputBytes).toBe(8 * 1024 ** 3);
    expect(policy.managedQuotaBytes).toBe(1024);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('intersects admission ceilings and reports actual broker host controls', () => {
    const broker = getPrivateRArtifactPolicy({ PRIVATE_R_MAX_OUTPUT_BYTES: String(256 * 1024 ** 2),
      PRIVATE_R_MAX_INPUT_FILE_BYTES: String(300 * 1024 ** 2), PRIVATE_R_DISK_RESERVE_BYTES: String(2 * 1024 ** 3),
      PRIVATE_R_TRANSFER_TIMEOUT_SECONDS: '120' });
    const effective = effectivePrivateRArtifactPolicy({ state: 'ready', persistentKernel: true,
      persistentKernelStreamedPublications: true, privateRArtifactPolicy: broker }, {
      PRIVATE_R_DISK_RESERVE_BYTES: String(3 * 1024 ** 3), PRIVATE_R_TRANSFER_TIMEOUT_SECONDS: '30' });
    expect(effective).toMatchObject({ maxOutputBytes: 256 * 1024 ** 2, maxInputFileBytes: 300 * 1024 ** 2,
      diskReserveBytes: 2 * 1024 ** 3, transferTimeoutSeconds: 120 });
  });

  it('keeps older or unverified adapters at their actual publication envelope', () => {
    for (const raw of [undefined, {}, { ...getPrivateRArtifactPolicy({}), maxOutputBytes: '536870912' }]) {
      expect(effectivePrivateRArtifactPolicy({ state: 'ready', persistentKernel: true,
        persistentKernelStreamedPublications: true, privateRArtifactPolicy: raw }, {})).toMatchObject({
        maxOutputBytes: 20 * 1024 ** 2, maxInputFileBytes: 200 * 1024 ** 2,
        maxInputTotalBytes: 250 * 1024 ** 2, transferTimeoutSeconds: 30 });
    }
    expect(effectivePrivateRArtifactPolicy({ state: 'ready', persistentKernel: true,
      privateRArtifactPolicy: getPrivateRArtifactPolicy({}) }, {})).toMatchObject({
      maxOutputBytes: 20 * 1024 ** 2, maxInputFileBytes: 200 * 1024 ** 2, maxInputTotalBytes: 250 * 1024 ** 2 });
  });

  it('withholds policy for unavailable kernels and strips unrelated broker data', () => {
    expect(effectivePrivateRArtifactPolicy({ state: 'unreachable', persistentKernel: true }, {})).toBeNull();
    expect(effectivePrivateRArtifactPolicy({ state: 'ready' }, {})).toBeNull();
    const projected = validatePrivateRArtifactPolicy({ ...getPrivateRArtifactPolicy({}), hostPath: '/private/path' });
    expect(projected).not.toHaveProperty('hostPath');
    expect(() => validatePrivateRArtifactPolicy({ ...projected, transferTimeoutSeconds: 0 })).toThrow();
  });
});
