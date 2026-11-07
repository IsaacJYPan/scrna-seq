import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Bot, Check, ChevronDown, ChevronRight, Copy, KeyRound, Loader2, Power, RefreshCw, ShieldCheck,
} from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { publicErrorMessage } from '../publicError';
import AgentWorkflows from './AgentWorkflows';
import { APP_NAME } from '../brand';

// Human governance for delegated agents (docs/spec.md phases 0-1). This page
// only displays and changes delegations; every rule is enforced server-side.

const LIFETIMES = [
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 604800 },
  { label: '30 days', seconds: 2592000 },
];
const NO_API = Object.freeze({});
const CAPABILITY_LABELS = {
  'metadata.read': 'Read project and dataset metadata',
  'results.read': 'Read completed run summaries',
  'proposal.create': 'Submit code or method proposals (inert)',
  'workflow.plan': 'Plan runs of approved workflows in your studies',
  'workflow.executeApproved': 'Run approved workflows within study budgets',
  'run.cancelOwn': 'Cancel its own runs',
};

function errorText(error, fallback) {
  return publicErrorMessage(error?.message || fallback, fallback);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function StatusBadge({ status }) {
  const tone = status === 'active'
    ? 'border-success/30 bg-success/10 text-success'
    : 'border-border bg-surface text-textMuted';
  return <span className={`rounded border px-2 py-0.5 text-xs font-medium ${tone}`}>{status}</span>;
}

export default function AgentAccess(props) {
  const projectId = props.currentWs?.selectedProjectId || props.currentWs?.projects?.[0]?.id || null;
  return <AgentAccessProject key={projectId || 'no-project'} {...props} projectId={projectId} />;
}

function AgentAccessProject({ currentWs, userId, projectId, refreshAnalysisObjects, onSelectAnalysisObject, setActiveTab }) {
  const project = currentWs?.projects?.find(p => p.id === projectId) || null;
  const api = window.electronAPI || NO_API;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const [data, setData] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [issued, setIssued] = useState(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [proposalBody, setProposalBody] = useState({});
  const [reviewNote, setReviewNote] = useState('');
  const [form, setForm] = useState({
    agentName: '', clientLabel: '', capabilities: ['metadata.read'], disclosureProfile: 'identifiers',
    lifetimeSeconds: 604800, maxOpenProposals: 10, maxOutstandingRuns: 1, maxCpuHours: 4,
  });

  const load = useCallback(async () => {
    if (!projectId || !api.listAgentDelegations) return;
    setLoading(true);
    setError(null);
    try {
      const [delegations, proposalList, auditList] = await Promise.all([
        api.listAgentDelegations(projectId),
        api.listAgentProposals(projectId),
        api.listAutomationAudit(projectId),
      ]);
      if (!mounted.current) return;
      setData(delegations);
      setProposals(Array.isArray(proposalList?.proposals) ? proposalList.proposals : []);
      setAudit(Array.isArray(auditList?.events) ? auditList.events : []);
    } catch (err) {
      if (mounted.current) setError(errorText(err, 'Agent access is unavailable.'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [api, projectId]);

  useEffect(() => { load(); }, [load]);

  const run = async (key, action) => {
    setBusy(key);
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(errorText(err, 'The request was rejected.'));
      return null;
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const role = data?.viewerRole || project?.role || null;
  const catalog = (data?.catalog || []).filter(c => c.availability === 'delegable');
  const canManageProject = role === 'owner' || role === 'admin';

  const toggleCapability = (name) => setForm(f => ({
    ...f,
    capabilities: f.capabilities.includes(name) ? f.capabilities.filter(c => c !== name) : [...f.capabilities, name],
  }));

  const create = async (event) => {
    event.preventDefault();
    const body = {
      agentName: form.agentName,
      capabilities: form.capabilities,
      disclosureProfile: form.disclosureProfile,
      lifetimeSeconds: Number(form.lifetimeSeconds),
      limits: {
        maxOpenProposals: Number(form.maxOpenProposals),
        maxOutstandingRuns: Number(form.maxOutstandingRuns),
        maxReservedCpuSeconds: Math.round(Number(form.maxCpuHours) * 3600),
      },
    };
    if (form.clientLabel.trim()) body.clientLabel = form.clientLabel;
    const result = await run('create', () => api.createAgentDelegation(projectId, body));
    if (result) {
      setIssued({ agentName: result.delegation.agent.displayName, ...result.credential });
      setCopied(false);
      setForm(f => ({ ...f, agentName: '', clientLabel: '' }));
      await load();
    }
  };

  const issueCredential = async (delegation) => {
    const result = await run(`issue:${delegation.id}`, () => api.issueAgentCredential(projectId, delegation.id));
    if (result) {
      setIssued({ agentName: delegation.agent.displayName, ...result.credential });
      setCopied(false);
      await load();
    }
  };

  const mutateAndReload = async (key, action) => {
    if (await run(key, action)) await load();
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const toggleProposal = async (proposal) => {
    if (expanded === proposal.id) { setExpanded(null); return; }
    setExpanded(proposal.id);
    setReviewNote('');
    if (!proposalBody[proposal.id]) {
      const full = await run(`load:${proposal.id}`, () => api.getAgentProposal(projectId, proposal.id));
      if (full) setProposalBody(b => ({ ...b, [proposal.id]: full.body || '' }));
    }
  };

  if (!projectId) {
    return <div className="p-8 text-sm text-textMuted">Select a project to manage agent access.</div>;
  }

  const delegations = data?.delegations || [];
  return (
    <div className="h-full w-full overflow-y-auto bg-background p-4 sm:p-8 custom-scrollbar">
      <div className="mx-auto max-w-5xl space-y-7">
        <PageHeader title="Agent access" icon={Bot} className="border-b border-border pb-5"
          description={<>Delegate narrow, revocable authority in <span className="font-bold text-text">{project?.name || 'this project'}</span> to an AI agent.</>}
          actions={<button onClick={load} disabled={loading || Boolean(busy)} className="btn btn-secondary">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} Refresh
          </button>} />

        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-textMuted">
          <div className="mb-1 flex items-center gap-2 font-bold text-text"><ShieldCheck size={17} className="text-primary" /> What an agent can do here</div>
          <p>An agent acts with its own credential, never your session. Its authority is what you delegate, narrowed by your current project role and re-checked on every request.
            Agents can read bounded metadata, submit <span className="font-bold text-text">inert proposals</span>, and run <span className="font-bold text-text">approved workflows inside your studies</span>. They cannot run their own code or R, export data, approve workflows, or accept results.</p>
          <p className="mt-2">Run the agent under a separate account or isolated runtime that cannot reach your browser, SSH keys, or password. If an agent can use your own login, {APP_NAME} cannot tell it apart from you.</p>
        </div>

        {error && (
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-danger">
            <div className="flex items-center gap-2 font-bold"><AlertTriangle size={18} /> Request rejected</div>
            <p className="mt-1 text-sm">{error}</p>
          </div>
        )}

        {issued && (
          <div role="status" className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
            <div className="flex items-center gap-2 font-bold text-text"><KeyRound size={17} /> Credential for {issued.agentName}</div>
            <p className="mt-1 text-textMuted">Copy it now; it is not shown again. Give it to the agent as <code>TRACEOMICS_AGENT_TOKEN</code>. Expires {formatDate(issued.expiresAt)}.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code data-testid="agent-token" className="min-w-0 flex-1 break-all rounded border border-border bg-background px-3 py-2 text-xs text-text">{issued.token}</code>
              <button type="button" onClick={copyToken} className="btn btn-secondary text-sm">{copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy'}</button>
              <button type="button" onClick={() => setIssued(null)} className="btn btn-secondary text-sm">Done</button>
            </div>
          </div>
        )}

        <form onSubmit={create} className="rounded-lg border border-border bg-surface p-5 space-y-4" aria-label="Delegate to a new agent">
          <div>
            <h3 className="text-lg font-bold text-text">Delegate to a new agent</h3>
            <p className="mt-1 text-sm text-textMuted">You remain the responsible sponsor. You can revoke it at any time.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs font-bold text-textMuted">Agent name
              <input required maxLength={120} value={form.agentName} onChange={e => setForm(f => ({ ...f, agentName: e.target.value }))}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" placeholder="QC assistant" />
            </label>
            <label className="space-y-1 text-xs font-bold text-textMuted">Client label (optional, descriptive only)
              <input maxLength={120} value={form.clientLabel} onChange={e => setForm(f => ({ ...f, clientLabel: e.target.value }))}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
            </label>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs font-bold text-textMuted">Capabilities</legend>
            {catalog.map(cap => {
              const allowed = !role || (cap.sponsorRoles || []).includes(role);
              return (
                <label key={cap.name} className={`flex items-center gap-2 text-sm ${allowed ? 'text-text' : 'text-textMuted'}`}>
                  <input type="checkbox" disabled={!allowed} checked={form.capabilities.includes(cap.name)} onChange={() => toggleCapability(cap.name)} />
                  {CAPABILITY_LABELS[cap.name] || cap.name} <code className="text-xs text-textMuted">{cap.name}</code>
                  {!allowed && <span className="text-xs">(not in your role)</span>}
                </label>
              );
            })}
          </fieldset>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="space-y-1 text-xs font-bold text-textMuted">Visible to the agent
              <select value={form.disclosureProfile} onChange={e => setForm(f => ({ ...f, disclosureProfile: e.target.value }))}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text">
                <option value="identifiers">Identifiers and status only</option>
                <option value="labels">Also names and filenames</option>
              </select>
            </label>
            <label className="space-y-1 text-xs font-bold text-textMuted">Expires after
              <select value={form.lifetimeSeconds} onChange={e => setForm(f => ({ ...f, lifetimeSeconds: Number(e.target.value) }))}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text">
                {LIFETIMES.map(l => <option key={l.seconds} value={l.seconds}>{l.label}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs font-bold text-textMuted">Max active runs
              <input type="number" min={0} max={10} value={form.maxOutstandingRuns} onChange={e => setForm(f => ({ ...f, maxOutstandingRuns: e.target.value }))}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
            </label>
            <label className="space-y-1 text-xs font-bold text-textMuted">Total compute budget (CPU-hours)
              <input type="number" min={0} max={1000} value={form.maxCpuHours} onChange={e => setForm(f => ({ ...f, maxCpuHours: e.target.value }))}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
            </label>
            <label className="space-y-1 text-xs font-bold text-textMuted">Max open proposals
              <input type="number" min={0} max={50} value={form.maxOpenProposals} onChange={e => setForm(f => ({ ...f, maxOpenProposals: e.target.value }))}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
            </label>
          </div>
          <p className="text-xs text-textMuted">Never available to agents: running their own code or R, data export, approving workflows, or accepting results.</p>
          <button type="submit" disabled={Boolean(busy) || !form.agentName.trim() || form.capabilities.length === 0} className="btn btn-primary inline-flex items-center gap-2 text-sm">
            {busy === 'create' ? <Loader2 size={16} className="animate-spin" /> : <Bot size={16} />} Create agent and credential
          </button>
        </form>

        <section className="space-y-3" aria-label="Delegated agents">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold text-text">Delegated agents</h3>
              <p className="mt-1 text-sm text-textMuted">{data?.scope === 'project' ? 'All agents in this project.' : 'Agents you sponsor.'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={Boolean(busy)} onClick={() => mutateAndReload('kill:mine', () => api.revokeAllAgentDelegations(projectId, 'mine'))} className="btn btn-secondary text-sm">
                <Power size={16} /> Revoke all my agents
              </button>
              {canManageProject && (
                <button type="button" disabled={Boolean(busy)} onClick={() => mutateAndReload('kill:project', () => api.revokeAllAgentDelegations(projectId, 'project'))} className="btn btn-secondary text-sm text-danger">
                  <Power size={16} /> Revoke every agent in project
                </button>
              )}
            </div>
          </div>
          {delegations.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-textMuted">No agents have been delegated.</div>
          ) : delegations.map(d => (
            <article key={d.id} className="rounded-lg border border-border bg-surface p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-bold text-text">{d.agent.displayName}</p>
                    <span className="rounded border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300">agent</span>
                    <StatusBadge status={d.status} />
                  </div>
                  <p className="text-textMuted">Sponsor: {d.sponsor.displayName}{Number(d.sponsor.userId) === Number(userId) ? ' (you)' : ''}{d.agent.clientLabel ? ` · Client: ${d.agent.clientLabel}` : ''}</p>
                  <p className="text-textMuted">Capabilities: {d.capabilities.join(', ')} · Visibility: {d.disclosureProfile}</p>
                  <p className="text-textMuted">Limits: {d.policy.maxOpenProposals} open proposals · {d.policy.maxRequestsPerMinute} requests/min · {d.capabilities.includes('workflow.executeApproved') ? `${d.policy.maxOutstandingRuns ?? 0} active runs, ${Math.round((d.policy.maxReservedCpuSeconds ?? 0) / 360) / 10} CPU-hours total` : 'no runs'} · own code never</p>
                  <p className="text-textMuted">Expires {formatDate(d.expiresAt)}{d.revokedAt ? ` · Revoked ${formatDate(d.revokedAt)} (${d.revocationReason})` : ''}</p>
                </div>
                {d.status === 'active' && (
                  <div className="flex flex-wrap gap-2">
                    {Number(d.sponsor.userId) === Number(userId) && (
                      <button type="button" disabled={Boolean(busy)} onClick={() => issueCredential(d)} className="btn btn-secondary text-sm"><KeyRound size={16} /> New credential</button>
                    )}
                    <button type="button" disabled={Boolean(busy)} onClick={() => mutateAndReload(`revoke:${d.id}`, () => api.revokeAgentDelegation(projectId, d.id))} className="btn btn-secondary text-sm text-danger">Revoke</button>
                  </div>
                )}
              </div>
              {d.credentials.length > 0 && (
                <ul className="mt-3 space-y-1 border-t border-border pt-3">
                  {d.credentials.map(c => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-textMuted">
                      <span><code>{c.hint}</code> · <StatusBadge status={c.status} /> · last used {formatDate(c.lastUsedAt)} · expires {formatDate(c.expiresAt)}</span>
                      {c.status === 'active' && d.status === 'active' && (
                        <button type="button" disabled={Boolean(busy)} onClick={() => mutateAndReload(`cred:${c.id}`, () => api.revokeAgentCredential(projectId, d.id, c.id))} className="text-danger underline">Revoke credential</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </section>

        <AgentWorkflows projectId={projectId} role={role} onChanged={load}
          onOpenResult={onSelectAnalysisObject ? async (objectId) => {
            if (typeof refreshAnalysisObjects === 'function') await refreshAnalysisObjects(projectId);
            await onSelectAnalysisObject(projectId, objectId);
            setActiveTab?.('workspace');
          } : undefined} />

        <section className="space-y-3" aria-label="Agent proposals">
          <div>
            <h3 className="text-lg font-bold text-text">Proposals</h3>
            <p className="mt-1 text-sm text-textMuted">Proposals are shown as plain text and never run. Noting a proposal is not an approval.</p>
          </div>
          {proposals.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-textMuted">No proposals yet.</div>
          ) : proposals.map(p => (
            <article key={p.id} className="rounded-lg border border-border bg-surface p-4 text-sm">
              <button type="button" onClick={() => toggleProposal(p)} aria-expanded={expanded === p.id} className="flex w-full items-start gap-2 text-left">
                {expanded === p.id ? <ChevronDown size={16} className="mt-0.5" /> : <ChevronRight size={16} className="mt-0.5" />}
                <span className="min-w-0 flex-1">
                  <span className="font-bold text-text">{p.title}</span>
                  <span className="ml-2 text-xs text-textMuted">{p.kind} · by {p.agent.displayName || 'agent'} · {formatDate(p.createdAt)}</span>
                </span>
                <StatusBadge status={p.reviewState} />
              </button>
              {expanded === p.id && (
                <div className="mt-3 space-y-3">
                  {p.summary && <p className="whitespace-pre-wrap text-textMuted">{p.summary}</p>}
                  <pre className="max-h-96 overflow-auto rounded border border-border bg-background p-3 text-xs text-text">{proposalBody[p.id] ?? 'Loading…'}</pre>
                  <p className="text-xs text-textMuted">SHA-256 {p.bodySha256} · {p.bodyBytes} bytes</p>
                  {p.reviewState === 'open' && role !== 'viewer' && (
                    <div className="space-y-2">
                      <textarea aria-label="Review note" maxLength={2000} value={reviewNote} onChange={e => setReviewNote(e.target.value)}
                        className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-text" placeholder="Optional note" />
                      <div className="flex gap-2">
                        <button type="button" disabled={Boolean(busy)} onClick={() => mutateAndReload(`review:${p.id}`, () => api.reviewAgentProposal(projectId, p.id, 'noted', reviewNote.trim()))} className="btn btn-secondary text-sm">Note for later</button>
                        <button type="button" disabled={Boolean(busy)} onClick={() => mutateAndReload(`review:${p.id}`, () => api.reviewAgentProposal(projectId, p.id, 'declined', reviewNote.trim()))} className="btn btn-secondary text-sm text-danger">Decline</button>
                      </div>
                    </div>
                  )}
                  {p.reviewNote && <p className="text-xs text-textMuted">Review note: {p.reviewNote}</p>}
                </div>
              )}
            </article>
          ))}
        </section>

        <section className="space-y-3" aria-label="Agent activity">
          <h3 className="text-lg font-bold text-text">Activity</h3>
          {audit.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-textMuted">No agent activity recorded.</div>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-surface text-xs">
              {audit.map(e => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-textMuted">
                  <span className={`rounded border px-1.5 py-0.5 font-medium ${e.actor.kind === 'agent' ? 'border-violet-500/30 text-violet-700 dark:text-violet-300' : 'border-border'}`}>{e.actor.kind}</span>
                  <span className="text-text">{e.actor.displayName || e.actor.principalId || e.actor.userId}</span>
                  <code>{e.action}</code>
                  <span className={e.decision === 'denied' ? 'text-danger' : ''}>{e.decision}{e.reasonCode ? ` (${e.reasonCode})` : ''}</span>
                  <span className="ml-auto">{formatDate(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
