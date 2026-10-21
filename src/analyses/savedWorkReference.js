export const savedReferenceId = reference => reference?.kind === 'workflow-snapshot'
  ? reference.snapshotId : reference?.kind === 'analysis-object' ? reference.checkpointVersionId : reference?.versionId;

export const savedReferenceTitle = reference => reference?.kind === 'workflow-snapshot'
  ? 'Saved workflow snapshot' : reference?.kind === 'analysis-object' ? 'Saved analysis object' : 'Saved artifact version';
