import React from 'react';

const RetainedArtifactView = React.lazy(() => import('../components/RetainedArtifactView'));
const RetainedWorkflowSnapshotView = React.lazy(() => import('./RetainedWorkflowSnapshotView'));

export default function RetainedWorkView({ reference, ...props }) {
  return reference?.kind === 'workflow-snapshot'
    ? <RetainedWorkflowSnapshotView key={`${props.userId}:${props.projectId}:${reference.snapshotId}:${reference.sha256}`} reference={reference} {...props} />
    : <RetainedArtifactView reference={reference} {...props} />;
}
