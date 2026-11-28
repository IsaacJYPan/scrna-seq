import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { formatDate } from '../../components/analysisRunDisplay';
import {
  formatApiError, formatJobError, badgeClass, displayJobLabel, displayArtifactLabel, displayProvenanceLabel, displayStatus,
} from './historyDisplay';

function StatusBadge({ children, tone = 'slate' }) {
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${badgeClass(tone)}`}>
      {children}
    </span>
  );
}

export function Section({ title, subtitle, children }) {
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-text">{title}</h3>
          {subtitle && <p className="mt-1 text-sm text-textMuted">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ title, children }) {
  return (
    <p className="text-sm text-textMuted">
      {title}.{children ? <> {children}</> : null}
    </p>
  );
}

const MANUALLY_RETRYABLE_JOB_TYPES = new Set([
  'pbmc.pipeline.v1', 'seurat.pipeline.v1', 'seurat.multisample.v1', 'spatial.seurat.v1',
  'deg.find_markers.v1', 'enrichment.gsea.v1', 'cellchat.infer.v1',
  'explore.summarize.v1', 'condition.pseudobulk_de.v1',
]);

export function JobList({
  jobs,
  analysisObjects = [],
  userId,
  onRetry,
  retryState,
  emptyTitle = 'No runs yet',
  emptyCopy = '',
}) {
  if (!jobs.length) {
    return (
      <EmptyState title={emptyTitle}>
        {emptyCopy}
      </EmptyState>
    );
  }

  const analysisNamesById = new Map(analysisObjects.map((analysis) => [
    analysis.id, analysis.displayName || analysis.name || 'Dataset',
  ]));
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const retryChildrenBySource = new Map(
    jobs.filter((job) => job.retryOfJobId).map((job) => [job.retryOfJobId, job])
  );

  return (
    <div className="space-y-2">
      {jobs.map(job => {
        const sourceName = analysisNamesById.get(job.analysisObjectId);
        const resultName = analysisNamesById.get(job.resultAnalysisObjectId);
        const owner = Number(job.ownerUserId) === Number(userId) ? 'You' : 'Project collaborator';
        const retrySource = jobsById.get(job.retryOfJobId);
        const retryChild = retryChildrenBySource.get(job.id);
        const retryEligible = owner === 'You'
          && ['failed', 'canceled'].includes(job.status)
          && MANUALLY_RETRYABLE_JOB_TYPES.has(job.jobType);
        const canRetry = Boolean(onRetry) && retryEligible;
        const activeRetry = retryState?.sourceJobId === job.id ? retryState : null;
        return (
        <div key={job.id} className="panel">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-bold text-text">{displayJobLabel(job.jobType)}</p>
                <StatusBadge tone={job.status === 'completed' ? 'green' : job.status === 'failed' ? 'rose' : 'amber'}>
                  {displayStatus(job.status)}
                </StatusBadge>
              </div>
              <div className="mt-2 grid gap-1 text-xs text-textMuted sm:grid-cols-2">
                <span>Owner: <span className="text-text">{owner}</span></span>
                <span>Input: <span className="text-text">{sourceName || 'No saved-analysis input'}</span></span>
                {resultName && <span>Saved result: <span className="text-text">{resultName}</span></span>}
                {retrySource && <span>Recovery: <span className="text-text">Retry of prior {displayJobLabel(retrySource.jobType).toLowerCase()} run</span></span>}
              </div>
            </div>
            <p className="text-xs text-textMuted">{formatDate(job.createdAt)}</p>
          </div>
          {(['failed', 'canceled'].includes(job.status) || job.error) && (
            <div className="mt-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {formatJobError(job)}
              {retryEligible ? (
                <div className="mt-1 text-textMuted">
                  Recovery: review the named input and settings. A retry creates a separate run from the recorded inputs, preserves this record, and repeats current access and input validation.
                </div>
              ) : (
                <div className="mt-1 text-textMuted">
                  Recovery: return to this workflow, review the named input and settings, then start a new run.
                </div>
              )}
              {canRetry && !retryChild && (
                <button
                  onClick={() => onRetry(job)}
                  disabled={Boolean(activeRetry?.launching)}
                  className="btn btn-secondary mt-2 inline-flex items-center gap-2 text-xs disabled:opacity-50"
                >
                  {activeRetry?.launching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  {activeRetry?.launching ? 'Starting retry…' : 'Retry as new run'}
                </button>
              )}
              {retryChild && (
                <div className="mt-2 text-textMuted">
                  Separate retry run: <span className="text-text">{displayStatus(retryChild.status)}</span>.
                </div>
              )}
              {activeRetry?.error && <div role="alert" className="mt-2">{activeRetry.error}</div>}
            </div>
          )}
        </div>
      );})}
    </div>
  );
}

const DOWNLOADABLE_ARTIFACT_TYPES = new Set([
  'deg_markers', 'enrichment_results', 'cellchat_results',
  'condition_de_results', 'expert_r_bundle',
]);

export function ArtifactList({ artifacts, jobs = [], analysisObjects = [], canFork, forkBusy, forkState, onFork, onOpenFork, onDownload }) {
  const [downloadState, setDownloadState] = useState(null);
  if (!artifacts.length) {
    return (
      <EmptyState title="No saved results yet" />
    );
  }

  const loadableCheckpointsByObject = new Map();
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const analysisNamesById = new Map(analysisObjects.map((analysis) => [analysis.id, analysis.displayName || analysis.name]));
  for (const artifact of artifacts) {
    if (artifact.artifactType === 'checkpoint'
        && artifact.storageKind === 'local_internal'
        && artifact.status === 'available'
        && artifact.resultAnalysisObjectId) {
      const candidates = loadableCheckpointsByObject.get(artifact.resultAnalysisObjectId) || [];
      candidates.push(artifact);
      loadableCheckpointsByObject.set(artifact.resultAnalysisObjectId, candidates);
    }
  }

  return (
    <div tabIndex={0} role="region" aria-label="Saved results table"
      className="overflow-x-auto rounded-lg border border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2">
      <table className="min-w-[560px] w-full text-left text-xs">
        <thead className="bg-slate-800 text-xs font-medium text-textMuted">
          <tr>
            <th className="p-3">Saved result</th>
            <th className="p-3">Status</th>
            <th className="p-3">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40 bg-surface/70">
          {artifacts.map(artifact => {
            const sourceJob = jobsById.get(artifact.jobId);
            const sourceAnalysisId = artifact.analysisObjectId || sourceJob?.analysisObjectId;
            const sourceAnalysisName = analysisNamesById.get(sourceAnalysisId);
            const recordedAt = artifact.createdAt || sourceJob?.createdAt;
            const isCheckpoint = artifact.artifactType === 'checkpoint';
            const isLoadableCheckpoint = isCheckpoint
              && artifact.storageKind === 'local_internal'
              && artifact.status === 'available'
              && Boolean(artifact.resultAnalysisObjectId);
            const availability = isCheckpoint && !isLoadableCheckpoint && artifact.status === 'available'
              ? 'unavailable' : artifact.status;
            const checkpointCandidates = isLoadableCheckpoint
              ? (loadableCheckpointsByObject.get(artifact.resultAnalysisObjectId) || [])
              : [];
            const isAmbiguousCheckpoint = checkpointCandidates.length > 1;
            const isForkableCheckpoint = isLoadableCheckpoint && checkpointCandidates.length === 1;
            const activeFork = forkState?.artifactId === artifact.id ? forkState : null;
            const canDownload = artifact.status === 'available'
              && artifact.storageKind === 'local_internal'
              && DOWNLOADABLE_ARTIFACT_TYPES.has(artifact.artifactType);
            return (
            <tr key={artifact.id}>
              <td className="p-3">
                <div className="font-bold text-text">{displayArtifactLabel(artifact.artifactType)}</div>
                {sourceAnalysisName && <div className="mt-1 text-xs text-textMuted">From {sourceAnalysisName}</div>}
                {recordedAt && <div className="mt-1 text-xs text-textMuted">Recorded: {formatDate(recordedAt)}</div>}
              </td>
              <td className="p-3"><StatusBadge tone={availability === 'available' ? 'green' : 'amber'}>{displayStatus(availability)}</StatusBadge></td>
              <td className="p-3">
                {canDownload ? (
                  <div>
                    <button
                      onClick={async () => {
                        setDownloadState({ artifactId: artifact.id, loading: true, error: '' });
                        try {
                          await onDownload(artifact);
                          setDownloadState(null);
                        } catch (error) {
                          setDownloadState({
                            artifactId: artifact.id,
                            loading: false,
                            error: formatApiError(error, 'Download failed.'),
                          });
                        }
                      }}
                      disabled={downloadState?.artifactId === artifact.id && downloadState.loading}
                      className="btn btn-secondary text-xs"
                    >
                      {downloadState?.artifactId === artifact.id && downloadState.loading
                        ? 'Preparing…' : 'Download result'}
                    </button>
                    {downloadState?.artifactId === artifact.id && downloadState.error && (
                      <div className="mt-2 max-w-xs text-danger">{downloadState.error}</div>
                    )}
                  </div>
                ) : isAmbiguousCheckpoint ? (
                  <span className="text-textMuted">Multiple saved versions are available, so this version cannot be selected automatically.</span>
                ) : isCheckpoint && !isLoadableCheckpoint ? (
                  <span className="text-textMuted">This saved version is unavailable.</span>
                ) : !isForkableCheckpoint ? (
                  <span className="text-textMuted">—</span>
                ) : !canFork ? (
                  <span className="text-textMuted">Writer role required</span>
                ) : forkBusy && !activeFork ? (
                  <span className="text-textMuted">Another fork is in progress</span>
                ) : activeFork?.accessLost ? (
                  <span className="text-danger">Project access changed; refresh required</span>
                ) : activeFork?.job?.status === 'completed' && activeFork.job.resultAnalysisObjectId ? (
                  <button onClick={() => onOpenFork(activeFork.job.resultAnalysisObjectId)} className="btn btn-primary text-xs">
                    Open branch
                  </button>
                ) : activeFork?.job && ['queued', 'running'].includes(activeFork.job.status) ? (
                  <span role="status" className="inline-flex items-center gap-2 text-textMuted"><Loader2 size={13} className="animate-spin" /> {displayStatus(activeFork.job.status)}</span>
                ) : !activeFork?.launching ? (
                  <button onClick={() => onFork(artifact)} className="btn btn-secondary text-xs">
                    Create branch from this version
                  </button>
                ) : (
                  <button onClick={() => onFork(artifact)} disabled={activeFork?.launching} className="btn btn-secondary text-xs">
                    Creating branch…
                  </button>
                )}
                {activeFork?.error && <div className="mt-2 max-w-xs text-danger">{activeFork.error}</div>}
              </td>
            </tr>
          );})}
        </tbody>
      </table>
    </div>
  );
}

export function ProvenanceList({ provenance }) {
  if (!provenance.length) {
    return (
      <EmptyState title="No recorded analysis steps yet" />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {provenance.map(record => (
        <div key={record.id} className="panel">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold text-text">Recorded analysis step</p>
            <StatusBadge tone="blue">{displayProvenanceLabel(record.operation)}</StatusBadge>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-textMuted">
            <span>Created: {formatDate(record.createdAt || record.timestamp)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function LineageSummary({ lineage, selectedObjectId }) {
  if (!selectedObjectId) {
    return (
      <EmptyState title="No dataset selected">
        Select one on the Projects page to see its lineage.
      </EmptyState>
    );
  }
  if (!lineage) {
    return (
      <EmptyState title="No recorded relationships yet" />
    );
  }

  const nodes = Array.isArray(lineage.nodes) ? lineage.nodes : [];
  const edges = Array.isArray(lineage.edges) ? lineage.edges : [];

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="panel">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h4 className="text-sm font-bold text-text">Datasets</h4>
          <StatusBadge tone={lineage.truncated ? 'amber' : 'green'}>{lineage.truncated ? 'truncated' : 'bounded'}</StatusBadge>
        </div>
        {nodes.length === 0 ? (
          <p className="text-sm text-textMuted">No lineage nodes returned.</p>
        ) : (
          <div className="space-y-2">
            {nodes.map(node => (
              <div key={node.id} className="rounded border border-border/60 bg-black/10 p-3">
                <div className="text-sm font-bold text-text">{node.label || 'Dataset'}</div>
                <div className="mt-1 text-xs text-textMuted">Dataset</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="panel">
        <h4 className="mb-3 text-sm font-bold text-text">Edges</h4>
        {edges.length === 0 ? (
          <p className="text-sm text-textMuted">No recorded relationships for this analysis.</p>
        ) : (
          <div className="space-y-2">
            {edges.map(edge => (
              <div key={edge.id} className="rounded border border-border/60 bg-black/10 p-3 text-xs">
                <div className="font-bold text-text">Source analysis → derived analysis</div>
                <div className="mt-1 text-textMuted">Recorded lineage relationship</div>
                {edge.createdAt && <div className="mt-1 text-textMuted">Recorded: {formatDate(edge.createdAt)}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function FigureList({ figures }) {
  if (!figures.length) {
    return (
      <EmptyState title="No figures yet" />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {figures.map(figure => (
        <div key={figure.id} className="panel">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold text-text">{figure.title || 'Saved figure'}</p>
            <StatusBadge tone="blue">{figure.plotType || 'Figure'}</StatusBadge>
          </div>
          <p className="mt-2 text-xs text-textMuted">Created: {formatDate(figure.createdAt)}</p>
        </div>
      ))}
    </div>
  );
}
