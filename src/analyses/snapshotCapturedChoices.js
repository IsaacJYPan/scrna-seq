// Local chooser identities; no protected source values enter persistent storage.
export const capturedOptionsKey = (version, reference) => `captured-workflow-outputs:${version}:${reference.snapshotId}:${reference.sha256}`;
export const emptyCapturedContextSelection = () => ({ method: false, parameterKeys: [], seed: false, environment: false });
