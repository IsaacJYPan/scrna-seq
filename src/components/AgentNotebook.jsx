import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Bot, ClipboardList, Loader2, NotebookPen, RefreshCw, ShieldCheck, StickyNote, X } from 'lucide-react';
import ExactDetails from './ExactDetails';
import AgentRunNotebook from './AgentRunNotebook';
import AiAuthorshipBadge from './AiAuthorshipBadge';
import { formatDate } from './analysisRunDisplay';
import { publicErrorMessage } from '../publicError';
import { onProjectJobSettled } from '../projectJobEvents';
import { AGENT_NOTEBOOK_TABS, agentNotebookTabLabel } from '../../shared/agentNotebookTabs.mjs';

// The agent notebook: everything agents did in a project, read top to bottom
// like a notebook and filed under the analysis tab each step serves.
// Verified-code runs show the reviewed release and the agent's parameter
// choices; an agent's own script shows its R as numbered cells and stays
// flagged as AI-written code; notes are the agent's Markdown between cells;
// ledger cells are the agent's recorded decisions, labels, findings, issues
// and checklist answers, each with the outputs it cites.
// Cells are records: nothing here edits them.

const NO_API = {};
// Agents record ledger entries as they work; re-read often enough that a
// person watching sees them arrive.
const REFRESH_MS = 15000;
const safeUrl = (url) => (/^(https?:|mailto:|#)/i.test(String(url || '')) ? url : '');

// App tabs that show the cells of a notebook tab. Plot tabs read the
// exploratory cells, where figure-making methods are filed.
const APP_TAB_TO_NOTEBOOK_TAB = Object.freeze({
  qc: 'qc', normalize: 'normalize', pca: 'pca', integrate: 'integrate', cluster: 'cluster', umap: 'umap',
  deg: 'deg', enrichment: 'enrichment', cellchat: 'cellchat', explore: 'explore',
  featureplot: 'explore', heatmap: 'explore', dotplot: 'explore', geneviewer: 'explore',
});

export function notebookTabForAppTab(appTab) {
  return APP_TAB_TO_NOTEBOOK_TAB[appTab] || null;
}

const STATE_LABEL = {
  queued: 'Waiting for compute', running: 'Running', draft_ready: 'Draft ready', candidate_ready: 'Result ready',
  failed: 'Failed', canceled: 'Canceled', cancel_requested: 'Canceling',
};


function Markdown({ children }) {
  return <div className="prose prose-sm max-w-none text-text"><ReactMarkdown skipHtml urlTransform={safeUrl}>{children}</ReactMarkdown></div>;
}

function CellFrame({ index, kind, children, label }) {
  return (
    <section aria-label={label} className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] gap-2">
      <span className="pt-3 text-right font-mono text-xs text-textMuted" aria-hidden="true">[{index}]</span>
      <div className={`min-w-0 rounded-lg border p-4 ${kind === 'note' || kind === 'ledger' ? 'border-dashed border-border bg-transparent' : 'border-border bg-surface/50'}`}>
        {children}
      </div>
    </section>
  );
}

function lineage(cell, extra = []) {
  return [
    { label: 'Read saved version', value: cell.inputAnalysisObjectId },
    { label: 'Produced saved version', value: cell.resultAnalysisObjectId },
    ...extra,
  ];
}

function VerifiedBadge() {
  return (
    <span data-testid="verified-code-badge" className="inline-flex items-center gap-1 rounded border border-success/30 bg-success/10 px-1.5 py-0.5 text-xs font-semibold text-success">
      <ShieldCheck size={12} aria-hidden="true" /> Verified code
    </span>
  );
}

function Choices({ choices }) {
  const entries = Object.entries(choices || {});
  if (!entries.length) return <p className="text-xs text-textMuted">Release defaults; the agent changed no parameters.</p>;
  return (
    <table className="mt-1 text-xs" aria-label="Parameters the agent chose">
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key}>
            <th scope="row" className="py-0.5 pr-3 text-left font-mono font-normal text-textMuted">{key}</th>
            <td className="py-0.5 font-mono text-text">{typeof value === 'string' ? value : JSON.stringify(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VerifiedCell({ cell, index, projectId, api, theme }) {
  const [steps, setSteps] = useState(null);
  const [error, setError] = useState(null);
  const toggle = async () => {
    if (steps) { setSteps(null); return; }
    setError(null);
    try {
      setSteps(await api.getWorkflowReleaseSteps(projectId, cell.release.id));
    } catch (failure) {
      setError(publicErrorMessage(failure, 'The reviewed code could not be loaded.'));
    }
  };
  return (
    <CellFrame index={index} kind="verified" label={`Cell ${index}: verified run of ${cell.release.title}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <VerifiedBadge />
        <span className="font-semibold text-text">{cell.release.title}</span>
        <span className="text-textMuted">v{cell.release.version}</span>
        <span className="text-textMuted">· {STATE_LABEL[cell.state] || cell.state}</span>
        {cell.acceptance === 'accepted' && <span className="text-success">· Accepted by a person</span>}
      </div>
      <p className="mt-1 text-xs text-textMuted">
        Run by {cell.agent?.displayName || 'an agent'} in the study “{cell.study?.name || cell.study?.id}” (trial {cell.trialNumber}) · {formatDate(cell.createdAt)}
        <ExactDetails className="ml-1" label="Exact versions of this run" items={lineage(cell, [{ label: 'Release', value: cell.release?.key ? `${cell.release.key} v${cell.release.version}` : null }])} />
      </p>
      {cell.study?.objective && <div className="mt-3"><Markdown>{cell.study.objective}</Markdown></div>}
      <div className="mt-3"><Choices choices={cell.choices} /></div>
      {cell.failure && <p className="mt-2 text-xs text-danger">{cell.failure.message}</p>}
      {api.getWorkflowReleaseSteps && cell.release?.id && (
        <button type="button" onClick={toggle} aria-expanded={Boolean(steps)} className="mt-2 text-xs text-primary underline">
          {steps ? 'Hide the reviewed code' : 'Show the reviewed code'}
        </button>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
      {steps && (
        steps.steps?.length
          ? <div className="mt-3"><AgentRunNotebook run={{ id: cell.release.id, runNumber: 0, title: cell.release.title, steps: steps.steps, files: [], scriptSha256: steps.source?.sha256 }}
            projectId={projectId} theme={theme} label={`Reviewed code of ${cell.release.title}`} /></div>
          : <p className="mt-2 text-xs text-textMuted">This release has no readable R source to show.</p>
      )}
    </CellFrame>
  );
}

function AgentCodeCell({ cell, index, projectId, api, theme, canWrite, onOpenReview }) {
  return (
    <CellFrame index={index} kind="agent_code" label={`Cell ${index}: agent script ${cell.title}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <AiAuthorshipBadge authorship={{ agentName: cell.agent?.displayName, reviewState: cell.review?.state, reason: cell.reason }} />
        <span className="font-semibold text-text">{cell.title}</span>
        <span className="text-textMuted">· {STATE_LABEL[cell.state] || cell.state}</span>
      </div>
      <p className="mt-1 text-xs text-textMuted">
        Written by {cell.agent?.displayName || 'an agent'} · run {cell.runNumber} in the sandbox “{cell.sandboxName}” · {formatDate(cell.createdAt)}
        <ExactDetails className="ml-1" label="Exact versions of this run" items={lineage(cell, [{ label: 'Script SHA-256', value: cell.scriptSha256 }])} />
      </p>
      <p className="mt-2 text-xs text-textMuted">
        <span className="font-semibold text-text">Why not verified code: </span>
        {cell.reason || 'No reason was recorded (run submitted before reasons were required).'}
      </p>
      {!cell.tabAssigned && <p className="mt-1 text-xs text-textMuted">Filed under Exploratory analysis: this run was submitted before agents named a tab.</p>}
      {cell.error && <p className="mt-2 text-xs text-danger">{cell.error.message}</p>}
      {cell.review?.state === 'draft' && cell.state === 'draft_ready' && onOpenReview && (
        <button type="button" onClick={onOpenReview} className="mt-2 text-xs text-primary underline">Review this draft in Agent access</button>
      )}
      {cell.steps?.length > 0 && (
        <div className="mt-3">
          <AgentRunNotebook run={cell} projectId={projectId} theme={theme} canSave={canWrite}
            fileUrl={(name, options) => api.agentSandboxFileUrl?.(projectId, cell.id, name, options)}
            readText={api.readAgentSandboxText ? (name) => api.readAgentSandboxText(projectId, cell.id, name) : null} />
        </div>
      )}
    </CellFrame>
  );
}

function NoteCell({ cell, index }) {
  return (
    <CellFrame index={index} kind="note" label={`Cell ${index}: note from ${cell.agent?.displayName || 'an agent'}`}>
      <p className="mb-2 flex flex-wrap items-center gap-1 text-xs text-textMuted">
        <StickyNote size={12} aria-hidden="true" /> Note by {cell.agent?.displayName || 'an agent'} (AI-written) · {formatDate(cell.createdAt)}
      </p>
      <Markdown>{cell.markdown}</Markdown>
    </CellFrame>
  );
}

const LEDGER_KIND_LABEL = {
  decision: 'Decision', annotation: 'Cluster label', finding: 'Finding', issue: 'Issue', check: 'Checklist',
  interpretation: 'Interpretation', prediction: 'Prediction',
};

function ledgerBadge(cell) {
  if (cell.entryKind === 'issue') return cell.status === 'open' ? 'open' : cell.status;
  if (cell.entryKind === 'check') return cell.status ? cell.status.replace('_', ' ') : null;
  if (cell.entryKind === 'interpretation' && cell.outcome) return `prediction ${cell.outcome}`;
  return cell.confidence ? `${cell.confidence} confidence` : null;
}

function LedgerCell({ cell, index, projectId, api }) {
  const label = LEDGER_KIND_LABEL[cell.entryKind] || 'Ledger entry';
  const badge = ledgerBadge(cell);
  const warn = (cell.entryKind === 'issue' && cell.status === 'open') || cell.confidence === 'low' || cell.outcome === 'refuted';
  return (
    <CellFrame index={index} kind="ledger" label={`Cell ${index}: ${label.toLowerCase()} from ${cell.agent?.displayName || 'an agent'}`}>
      <p className="mb-1 flex flex-wrap items-center gap-1 text-xs text-textMuted">
        <ClipboardList size={12} aria-hidden="true" /> {label} by {cell.agent?.displayName || 'an agent'} · {formatDate(cell.createdAt)}
        {badge && <span className={`ml-1 rounded border px-1.5 text-[10px] font-bold uppercase ${warn ? 'border-warning/40 bg-warning/10 text-text' : 'border-border'}`}>{badge}</span>}
        {cell.sampleSupport && <span className="ml-1 text-[10px]">samples: {cell.sampleSupport.replace('_', ' ')}</span>}
      </p>
      <p className="text-sm font-bold text-text">{cell.title}</p>
      {cell.entryKind === 'interpretation' ? (
        <dl className="mt-1 space-y-1 text-sm text-text">
          <div><dt className="inline font-bold">Observed: </dt><dd className="inline">{cell.summary?.split('\n')[0]}</dd></div>
          <div><dt className="inline font-bold">Means: </dt><dd className="inline">{cell.meaning}</dd></div>
          {cell.alternatives.length > 0 && <div><dt className="inline font-bold">Or: </dt><dd className="inline">{cell.alternatives.join('; ')}</dd></div>}
          {cell.test && <div><dt className="inline font-bold">Would tell apart: </dt><dd className="inline">{cell.test}</dd></div>}
          <div><dt className="inline font-bold">Next: </dt><dd className="inline">{cell.nextStep}</dd></div>
        </dl>
      ) : cell.summary && <p className="mt-1 text-sm text-text">{cell.summary}</p>}
      {cell.markers.length > 0 && <p className="mt-1 text-xs text-textMuted">Markers: {cell.markers.join(', ')}</p>}
      {cell.entryKind !== 'interpretation' && cell.alternatives.length > 0 && <p className="text-xs text-textMuted">Alternatives: {cell.alternatives.join(', ')}</p>}
      {cell.evidence.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {cell.evidence.map((ref) => {
            const text = [ref.file, ref.locator && `@ ${ref.locator}`, ref.value && `= ${ref.value}`, ref.valueCheck === 'matched' && '✓'].filter(Boolean).join(' ');
            const href = ref.sandboxRunId && ref.file ? api.agentSandboxFileUrl?.(projectId, ref.sandboxRunId, ref.file) : null;
            return (
              <li key={`${ref.sandboxRunId || ref.runId}:${ref.file}:${ref.locator || ''}`} className="break-words text-textMuted">
                {href ? <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">{text}</a> : text}
                <span className="ml-1 text-[10px]">{ref.sandboxRunId || ref.runId}</span>
              </li>
            );
          })}
        </ul>
      )}
    </CellFrame>
  );
}

// The cells, numbered from 1, with a heading wherever the analysis step
// changes (the full notebook) or without headings (one tab's cells).
export function AgentNotebookCells({ cells, projectId, api = NO_API, theme, canWrite = false, showTabHeadings = true, onOpenTab }) {
  const rows = [];
  cells.forEach((cell, position) => {
    if (showTabHeadings && (position === 0 || cells[position - 1].tab !== cell.tab)) {
      rows.push(
        <div key={`heading-${position}`} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1 pt-4 first:pt-0">
          <h3 className="text-sm font-bold text-text">{agentNotebookTabLabel(cell.tab)}</h3>
          {onOpenTab && <button type="button" onClick={() => onOpenTab(cell.tab)} className="text-xs text-primary underline">Open this tab</button>}
        </div>,
      );
    }
    const index = position + 1;
    const common = { cell, index, projectId, api, theme };
    rows.push(
      cell.kind === 'verified' ? <VerifiedCell key={cell.id} {...common} />
        : cell.kind === 'agent_code' ? <AgentCodeCell key={cell.id} {...common} canWrite={canWrite} onOpenReview={onOpenTab ? () => onOpenTab('agents') : null} />
          : cell.kind === 'ledger' ? <LedgerCell key={cell.id} {...common} />
            : <NoteCell key={cell.id} cell={cell} index={index} />,
    );
  });
  return <div className="space-y-3">{rows}</div>;
}

// Loads the project's notebook and reloads it whenever a project job settles.
export function useAgentNotebook(projectId, api = NO_API) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const live = useRef(true);
  // Set again on every mount: StrictMode mounts, unmounts and remounts.
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const load = useCallback(async () => {
    if (!projectId || !api.getAgentNotebook) { setState({ loading: false, data: null, error: null }); return; }
    setState((previous) => ({ ...previous, loading: true }));
    try {
      const data = await api.getAgentNotebook(projectId);
      if (live.current) setState({ loading: false, data, error: null });
    } catch (error) {
      if (live.current) setState((previous) => ({ loading: false, data: previous.data, error: publicErrorMessage(error, 'The agent notebook could not be loaded.') }));
    }
  }, [projectId, api]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onProjectJobSettled((event) => {
    if (String(event?.projectId) === String(projectId)) load();
  }), [projectId, load]);
  // Agents work through their own API, so the app never polls their jobs;
  // re-read every few seconds while the page is visible.
  useEffect(() => {
    if (!projectId || !api.getAgentNotebook) return undefined;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [projectId, api, load]);
  return { ...state, reload: load };
}

const WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);

// The whole notebook, on its own page.
export default function AgentNotebook({ projectId, role, theme, onOpenTab, api: injected }) {
  const api = injected || window.electronAPI || NO_API;
  const { loading, data, error, reload } = useAgentNotebook(projectId, api);
  const [filter, setFilter] = useState('all');
  const cells = useMemo(() => (data?.cells || []).filter((cell) => filter === 'all' || cell.tab === filter), [data, filter]);
  const counts = data?.tabs || AGENT_NOTEBOOK_TABS.map((tab) => ({ ...tab, cellCount: 0 }));
  const total = data?.cells?.length || 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-sm text-textMuted">
          Everything agents did in this project, oldest first, filed under the analysis step it serves.
          Verified code is reviewed release code; AI-written code is the agent&apos;s own script and needs a person&apos;s review.
        </p>
        <button type="button" onClick={reload} disabled={loading} className="btn btn-secondary inline-flex items-center gap-1 text-xs">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
        </button>
      </div>
      <div role="group" aria-label="Show cells from" className="flex flex-wrap gap-1">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}
          className={`rounded border px-2 py-1 text-xs ${filter === 'all' ? 'border-primary bg-primary/10 font-bold text-primary' : 'border-border text-textMuted'}`}>
          All steps ({total})
        </button>
        {counts.filter((tab) => tab.cellCount > 0).map((tab) => (
          <button key={tab.id} type="button" aria-pressed={filter === tab.id} onClick={() => setFilter(tab.id)}
            className={`rounded border px-2 py-1 text-xs ${filter === tab.id ? 'border-primary bg-primary/10 font-bold text-primary' : 'border-border text-textMuted'}`}>
            {tab.label} ({tab.cellCount})
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {data?.hiddenSandboxRuns > 0 && (
        <p className="text-xs text-textMuted">
          {data.hiddenSandboxRuns} agent script{data.hiddenSandboxRuns === 1 ? ' is' : 's are'} in sandboxes you can&apos;t review. Their owners and project admins see them here.
        </p>
      )}
      {!loading && data && total === 0 && (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="font-bold text-text">No agent work yet</p>
          <p className="mt-2 text-sm text-textMuted">When a delegated agent runs verified code, writes its own script or adds a note, it appears here in order.</p>
        </div>
      )}
      <AgentNotebookCells cells={cells} projectId={projectId} api={api} theme={theme} canWrite={WRITE_ROLES.has(role)}
        showTabHeadings={filter === 'all'} onOpenTab={onOpenTab} />
    </div>
  );
}

// The dock is an extra on every analysis tab; if it fails it disappears
// rather than taking the tab's page down with it.
class QuietBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('[AgentWorkDock]', error); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function AgentWorkDock(props) {
  return <QuietBoundary><AgentWorkDockPanel {...props} /></QuietBoundary>;
}

// On an analysis tab: a button showing how many agent cells belong to this
// step, opening a side panel with just those cells, in order.
function AgentWorkDockPanel({ projectId, activeTab, theme, role, onOpenNotebook, onOpenTab, api: injected }) {
  const api = injected || window.electronAPI || NO_API;
  const notebookTab = notebookTabForAppTab(activeTab);
  const { data } = useAgentNotebook(notebookTab ? projectId : null, api);
  const [open, setOpen] = useState(false);
  const closeRef = useRef(null);
  const cells = useMemo(() => (data?.cells || []).filter((cell) => cell.tab === notebookTab), [data, notebookTab]);
  useEffect(() => { setOpen(false); }, [activeTab]);
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  if (!notebookTab || cells.length === 0) return null;
  const needsReview = cells.filter((cell) => cell.kind === 'agent_code' && cell.review?.state === 'draft').length;
  const label = agentNotebookTabLabel(notebookTab);
  return (
    <>
      {!open && (
        <button type="button" onClick={() => setOpen(true)}
          className="absolute bottom-4 right-4 z-30 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-2 text-xs font-semibold text-text shadow-lg">
          <Bot size={14} aria-hidden="true" /> Agent work in this step · {cells.length}
          {needsReview > 0 && <span className="rounded bg-amber-500/15 px-1.5 text-amber-900 dark:text-amber-200">{needsReview} to review</span>}
        </button>
      )}
      {open && (
        <aside role="dialog" aria-label={`Agent work in ${label}`}
          onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}
          className="absolute inset-y-0 right-0 z-30 flex w-full max-w-2xl flex-col border-l border-border bg-background shadow-xl">
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-text">Agent work in {label}</h2>
              <p className="text-xs text-textMuted">{cells.length} cell{cells.length === 1 ? '' : 's'}, oldest first</p>
            </div>
            <div className="flex items-center gap-2">
              {onOpenNotebook && <button type="button" onClick={onOpenNotebook} className="inline-flex items-center gap-1 text-xs text-primary underline"><NotebookPen size={12} /> Whole notebook</button>}
              <button ref={closeRef} type="button" onClick={() => setOpen(false)} aria-label="Close agent work" className="rounded p-1 text-textMuted"><X size={16} /></button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <AgentNotebookCells cells={cells} projectId={projectId} api={api} theme={theme} canWrite={WRITE_ROLES.has(role)}
              showTabHeadings={false} onOpenTab={onOpenTab} />
          </div>
        </aside>
      )}
    </>
  );
}
