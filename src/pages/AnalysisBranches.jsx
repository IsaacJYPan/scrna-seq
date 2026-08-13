import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, GitBranch, GitCompare, History, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { publicErrorMessage } from '../publicError';

function messageFor(error, fallback) {
  return publicErrorMessage(error, fallback);
}

function savedAnalysisLabel(object) {
  return object?.displayName || object?.name || 'Saved analysis';
}

function analysisMethodLabel(summary) {
  const type = String(summary?.producingJobType || '');
  if (/seurat\.pipeline/i.test(type)) return 'Preprocessing workflow';
  if (/deg|condition/i.test(type)) return 'Condition comparison';
  if (/enrichment/i.test(type)) return 'Pathway enrichment';
  return 'Recorded analysis step';
}

function reviewStatusLabel(status) {
  const labels = {
    open: 'Open for review',
    approved: 'Approved',
    changes_requested: 'Changes requested',
    rejected: 'Not approved',
  };
  return labels[status] || 'Review recorded';
}

function comparisonRelationshipLabel(relation) {
  const labels = {
    shared_lineage: 'Shared lineage',
    diverged: 'Separate saved versions',
    unrelated: 'No recorded relationship',
  };
  return labels[relation] || 'Recorded relationship';
}

function activityLabel(action) {
  const labels = {
    'branch.created': 'Private branch created',
    'branch.published': 'Branch shared for review',
    'branch.promoted': 'Final project analysis updated',
    'review.requested': 'Review requested',
    'review.decided': 'Review decision recorded',
    'export.downloaded': 'Research record exported',
  };
  return labels[action] || 'Recorded project update';
}

export default function AnalysisBranches({ currentWs, datasetInfo, userId }) {
  const projectId = datasetInfo?.projectId || currentWs?.selectedProjectId || currentWs?.projects?.[0]?.id || null;
  const project = currentWs?.projects?.find((item) => item.id === projectId) || null;
  const canReview = project?.role === 'owner' || project?.role === 'admin';
  const objects = useMemo(
    () => (currentWs?.objects || []).filter((object) => object.projectId === projectId),
    [currentWs?.objects, projectId]
  );
  const [branches, setBranches] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [finalProjectAnalysis, setFinalProjectAnalysis] = useState(null);
  const [auditEvents, setAuditEvents] = useState([]);
  const [commentsByReview, setCommentsByReview] = useState({});
  const [commentDrafts, setCommentDrafts] = useState({});
  const [comparison, setComparison] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [baseObjectId, setBaseObjectId] = useState(datasetInfo?.id || '');
  const [leftBranchId, setLeftBranchId] = useState('');
  const [rightBranchId, setRightBranchId] = useState('');
  const [headSelections, setHeadSelections] = useState({});

  const refresh = useCallback(async () => {
    if (!projectId || !window.electronAPI?.listAnalysisBranches) return;
    setLoading(true);
    setError('');
    try {
      const [nextBranches, nextReviews, nextFinalProjectAnalysis, nextAudit] = await Promise.all([
        window.electronAPI.listAnalysisBranches(projectId),
        window.electronAPI.listAnalysisBranchReviews(projectId),
        window.electronAPI.getCanonicalAnalysis(projectId).catch(() => null),
        window.electronAPI.listProjectAuditEvents
          ? window.electronAPI.listProjectAuditEvents(projectId, { limit: 12 }).catch(() => [])
          : Promise.resolve([]),
      ]);
      setBranches(Array.isArray(nextBranches) ? nextBranches : []);
      setReviews(Array.isArray(nextReviews) ? nextReviews : []);
      setFinalProjectAnalysis(nextFinalProjectAnalysis || null);
      setAuditEvents(Array.isArray(nextAudit) ? nextAudit : []);
      if (window.electronAPI.listAnalysisBranchReviewComments) {
        const entries = await Promise.all((Array.isArray(nextReviews) ? nextReviews : [])
          .slice(0, 20)
          .map(async (review) => [
            review.id,
            await window.electronAPI.listAnalysisBranchReviewComments(projectId, review.id)
              .catch(() => []),
          ]));
        setCommentsByReview(Object.fromEntries(entries));
      }
    } catch (refreshError) {
      setError(messageFor(refreshError, 'Could not load analysis branches.'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setBaseObjectId(datasetInfo?.id || ''); }, [datasetInfo?.id]);

  const mutate = async (key, action) => {
    setBusy(key);
    setError('');
    try {
      await action();
      await refresh();
    } catch (mutationError) {
      setError(messageFor(mutationError, 'The branch operation failed.'));
    } finally {
      setBusy(null);
    }
  };

  const create = async (event) => {
    event.preventDefault();
    if (!name.trim() || !baseObjectId) return;
    await mutate('create', async () => {
      await window.electronAPI.createAnalysisBranch(projectId, {
        name: name.trim(), description: description.trim(), baseAnalysisObjectId: baseObjectId,
      });
      setName('');
      setDescription('');
    });
  };

  const requestReview = (branch) => mutate(`review-${branch.id}`, () => (
    window.electronAPI.requestAnalysisBranchReview(projectId, branch.id, {
      title: `Review ${branch.name}`,
      summary: 'Review this saved version for final-project selection.',
    })
  ));

  const approvedByBranch = new Map(
    reviews.filter((review) => review.status === 'approved')
      .map((review) => [review.branchId, review])
  );
  const objectById = new Map(objects.map((object) => [object.id, object]));
  const finalObject = finalProjectAnalysis
    ? objectById.get(finalProjectAnalysis.analysisObjectId)
    : null;

  if (!projectId) {
    return <div className="h-full grid place-items-center text-textMuted">Select a project to manage analysis branches.</div>;
  }

  return (
    <div className="h-full overflow-y-auto bg-background p-6">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-text flex items-center gap-2"><GitBranch size={24} /> Analysis Branches</h2>
            <p className="text-sm text-textMuted mt-1">Your private branches and project-shared branches appear here with their saved-analysis head and review state.</p>
          </div>
          <button className="btn btn-secondary text-sm" onClick={refresh} disabled={loading || !!busy}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        {error && <div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div>}

        <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-5">
          <section className="space-y-3">
            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-textMuted">Final project analysis</div>
              {finalProjectAnalysis ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-text">
                  <ShieldCheck size={18} className="text-success" />
                  <span className="font-semibold">Final project analysis selected</span>
                  <span className="text-textMuted">Project selection revision {finalProjectAnalysis.version}</span>
                  {finalObject && <span className="text-textMuted">· {savedAnalysisLabel(finalObject)}</span>}
                </div>
              ) : <p className="mt-2 text-sm text-textMuted">No final project analysis has been selected yet.</p>}
            </div>

            {loading ? (
              <div className="rounded-xl border border-border bg-surface p-10 grid place-items-center"><Loader2 className="animate-spin text-primary" /></div>
            ) : branches.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-surface p-8 text-center text-sm text-textMuted">Create a private branch from one of your saved versions.</div>
            ) : branches.map((branch) => {
              const owned = branch.ownerUserId === Number(userId);
              const branchReviews = reviews.filter((review) => review.branchId === branch.id);
              const approved = approvedByBranch.get(branch.id);
              const sourceObject = objectById.get(branch.baseAnalysisObjectId);
              const headObject = objectById.get(branch.headAnalysisObjectId);
              const latestReview = branchReviews[0];
              return (
                <article key={branch.id} className="rounded-xl border border-border bg-surface p-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-bold text-text">{branch.name}</div>
                      <div className="text-xs text-textMuted mt-1">Branch revision {branch.version} · Owner: {owned ? 'You' : 'Project collaborator'}</div>
                      <div className="text-xs text-textMuted mt-1">Source: {sourceObject ? savedAnalysisLabel(sourceObject) : 'Saved analysis unavailable'}</div>
                      <div className="text-xs text-textMuted mt-1">Current saved analysis: {headObject ? savedAnalysisLabel(headObject) : 'Saved analysis unavailable'}</div>
                      <div className="text-xs text-textMuted mt-1">Review: {latestReview ? reviewStatusLabel(latestReview.status) : 'Not requested'}</div>
                    </div>
                    <span className={`text-[11px] rounded-full border px-2 py-1 ${branch.visibility === 'private' ? 'border-amber-500/30 text-amber-700 dark:text-amber-300' : 'border-success/30 text-success'}`}>
                      {branch.visibility === 'private' ? 'Private draft' : 'Shared with project'}
                    </span>
                  </div>
                  {branch.description && <p className="text-sm text-textMuted">{branch.description}</p>}
                  {branchReviews.length > 0 && (
                    <div className="space-y-2 border-t border-border pt-3">
                      {branchReviews.map((review) => (
                        <div key={review.id} className="rounded border border-border bg-background/50 p-3 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-semibold text-text">{review.title}</span>
                            <span className="rounded border border-border px-2 py-1 text-textMuted">{reviewStatusLabel(review.status)}</span>
                          </div>
                          {review.summary && <p className="mt-2 text-textMuted">{review.summary}</p>}
                          {review.decisionNote && (
                            <p className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-text">
                              <span className="font-semibold">Decision note:</span> {review.decisionNote}
                            </p>
                          )}
                          {(commentsByReview[review.id] || []).map((comment) => (
                            <p key={comment.id} className="mt-2 rounded border border-border bg-surface p-2 text-textMuted">
                              <span className="font-semibold text-text">Review comment:</span> {comment.body}
                            </p>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {owned && branch.visibility === 'private' && (
                      <button className="btn btn-secondary text-xs" disabled={!!busy} onClick={() => mutate(`publish-${branch.id}`, () => window.electronAPI.publishAnalysisBranch(projectId, branch.id))}>Share for review</button>
                    )}
                    {owned && branch.visibility === 'project' && (
                      <button className="btn btn-secondary text-xs" disabled={!!busy} onClick={() => requestReview(branch)}>Request review</button>
                    )}
                    {canReview && approved && approved.headAnalysisObjectId === branch.headAnalysisObjectId && (
                      <button className="btn btn-primary text-xs" disabled={!!busy} onClick={() => mutate(`promote-${branch.id}`, () => window.electronAPI.promoteAnalysisBranch(projectId, branch.id, approved.id))}>Set as final project analysis</button>
                    )}
                    <button
                      className="btn btn-secondary text-xs"
                      disabled={!!busy}
                      onClick={() => mutate(`export-${branch.id}`, () => (
                        window.electronAPI.downloadReproducibilityManifest(projectId, { branchId: branch.id })
                      ))}
                    >
                      <Download size={13} /> Download review record
                    </button>
                  </div>
                  {owned && (
                    <div className="flex flex-col sm:flex-row gap-2 border-t border-border pt-3">
                      <select
                        className="input flex-1 text-xs"
                        aria-label={`Choose a newer saved version for ${branch.name}`}
                        value={headSelections[branch.id] || ''}
                        onChange={(event) => setHeadSelections((current) => ({
                          ...current, [branch.id]: event.target.value,
                        }))}
                      >
                        <option value="">Select a newer saved analysis</option>
                        {objects.filter((object) => Number(object.ownerUserId) === Number(userId)
                          && object.id !== branch.headAnalysisObjectId)
                          .map((object) => <option key={object.id} value={object.id}>{savedAnalysisLabel(object)}</option>)}
                      </select>
                      <button
                        className="btn btn-secondary text-xs"
                        disabled={!headSelections[branch.id] || !!busy}
                        onClick={() => mutate(`advance-${branch.id}`, () => window.electronAPI.advanceAnalysisBranch(
                          projectId, branch.id, headSelections[branch.id], branch.version
                        ))}
                      >
                        Update saved version
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </section>

          <aside className="space-y-5">
            <form className="rounded-xl border border-border bg-surface p-4 space-y-3" onSubmit={create}>
              <h3 className="font-bold text-text">Create a private branch</h3>
              <input className="input w-full" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. alternate QC strategy" maxLength={80} />
              <textarea className="input w-full min-h-20" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What are you testing?" maxLength={1000} />
              <select aria-label="Branch source saved analysis" className="input w-full" value={baseObjectId} onChange={(event) => setBaseObjectId(event.target.value)}>
                <option value="">Select an owned saved analysis</option>
                {objects.map((object) => <option key={object.id} value={object.id}>{savedAnalysisLabel(object)}</option>)}
              </select>
              <button className="btn btn-primary w-full" disabled={!name.trim() || !baseObjectId || !!busy}>{busy === 'create' ? 'Creating…' : 'Create private branch'}</button>
            </form>

            {canReview && reviews.some((review) => review.status === 'open') && (
              <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
                <h3 className="font-bold text-text">Open reviews</h3>
                {reviews.filter((review) => review.status === 'open').map((review) => (
                  <div key={review.id} className="border-t border-border pt-3 first:border-0 first:pt-0">
                    <div className="text-sm font-semibold text-text">{review.title}</div>
                    <div className="text-xs text-textMuted mt-1">Saved version available for review</div>
                    {(commentsByReview[review.id] || []).map((comment) => (
                      <div key={comment.id} className="mt-2 rounded border border-border bg-background p-2 text-xs text-textMuted">
                        <span className="font-semibold text-text">Reviewer:</span> {comment.body}
                      </div>
                    ))}
                    <div className="mt-2 flex gap-2">
                      <input
                        className="input min-w-0 flex-1 text-xs"
                        value={commentDrafts[review.id] || ''}
                        maxLength={4000}
                        placeholder="Add a method or provenance comment"
                        onChange={(event) => setCommentDrafts((current) => ({
                          ...current, [review.id]: event.target.value,
                        }))}
                      />
                      <button
                        className="btn btn-secondary text-xs"
                        disabled={!commentDrafts[review.id]?.trim() || !!busy}
                        onClick={() => mutate(`comment-${review.id}`, async () => {
                          await window.electronAPI.addAnalysisBranchReviewComment(
                            projectId, review.id, commentDrafts[review.id].trim()
                          );
                          setCommentDrafts((current) => ({ ...current, [review.id]: '' }));
                        })}
                      >Comment</button>
                    </div>
                    <div className="flex gap-2 mt-2">
                      <button className="btn btn-primary text-xs" disabled={!!busy} onClick={() => mutate(`approve-${review.id}`, () => window.electronAPI.decideAnalysisBranchReview(projectId, review.id, 'approved', 'Approved for final project consideration.'))}>Approve</button>
                      <button className="btn btn-secondary text-xs" disabled={!!busy} onClick={() => mutate(`changes-${review.id}`, () => window.electronAPI.decideAnalysisBranchReview(projectId, review.id, 'changes_requested', 'Changes requested before promotion.'))}>Request changes</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
              <h3 className="font-bold text-text flex items-center gap-2"><GitCompare size={17} /> Compare branches</h3>
              <select aria-label="Left branch" className="input w-full" value={leftBranchId} onChange={(event) => setLeftBranchId(event.target.value)}><option value="">Left branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>
              <select aria-label="Right branch" className="input w-full" value={rightBranchId} onChange={(event) => setRightBranchId(event.target.value)}><option value="">Right branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>
              <button className="btn btn-secondary w-full" disabled={!leftBranchId || !rightBranchId || !!busy} onClick={() => mutate('compare', async () => setComparison(await window.electronAPI.compareAnalysisBranches(projectId, leftBranchId, rightBranchId)))}>Compare recorded history</button>
              {comparison && (
                <div className="rounded-lg bg-background border border-border p-3 text-xs text-textMuted space-y-1">
                  <div>Relationship: <span className="font-bold text-text">{comparisonRelationshipLabel(comparison.relation)}</span></div>
                  <div>First saved version: <span className="text-text">{analysisMethodLabel(comparison.left?.summary)}</span></div>
                  <div>Second saved version: <span className="text-text">{analysisMethodLabel(comparison.right?.summary)}</span></div>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
              <h3 className="font-bold text-text flex items-center gap-2"><History size={17} /> Project activity</h3>
              {auditEvents.length === 0 ? (
                <p className="text-xs text-textMuted">No recorded branch or export activity yet.</p>
              ) : auditEvents.slice(0, 8).map((event) => (
                <div key={event.id} className="border-t border-border pt-2 first:border-0 first:pt-0">
                  <div className="text-xs font-semibold text-text">{activityLabel(event.action)}</div>
                  <div className="text-[11px] text-textMuted">{new Date(event.createdAt).toLocaleString()}</div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
