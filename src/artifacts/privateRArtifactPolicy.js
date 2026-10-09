const policyFields = [
  'maxOutputBytes', 'maxInputFileBytes', 'maxInputTotalBytes',
  'managedQuotaBytes', 'diskReserveBytes', 'transferTimeoutSeconds',
];

export function readPrivateRArtifactPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      policyFields.some(field => !Number.isSafeInteger(value[field]) || value[field] <= 0 ||
        value[field] > (field === 'transferTimeoutSeconds' ? 3600 : 64 * 1024 ** 3)) ||
      value.maxInputFileBytes > value.maxInputTotalBytes) return null;
  return Object.fromEntries(policyFields.map(field => [field, value[field]]));
}

export function artifactBytesLabel(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return 'Size unavailable';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
