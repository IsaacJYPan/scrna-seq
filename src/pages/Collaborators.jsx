import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Loader2, RefreshCw, ShieldCheck, Trash2,
  UserPlus, Users,
} from 'lucide-react';
import { publicErrorMessage } from '../publicError';

const ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const ROLE_HELP = {
  owner: 'Full project and membership control. Only owners can grant or remove owner access.',
  admin: 'Can manage non-owner members and project resources.',
  analyst: 'Can create analyses, run approved workflows, and create branches from saved versions.',
  viewer: 'Can read shared project metadata, saved results, and lineage only.',
};

function parseError(error, fallback) {
  if (!error) return fallback;
  try {
    const parsed = JSON.parse(error.message);
    return publicErrorMessage(parsed.error || fallback, fallback);
  } catch {
    return publicErrorMessage(error.message || fallback, fallback);
  }
}

function roleBadge(role) {
  const tones = {
    owner: 'border-primary/30 bg-primary/10 text-primary',
    admin: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
    analyst: 'border-success/30 bg-success/10 text-success',
    viewer: 'border-border bg-surface text-textMuted',
  };
  return tones[role] || tones.viewer;
}

export default function Collaborators(props) {
  const { currentWs } = props;
  const activeProjectId = currentWs?.selectedProjectId || currentWs?.projects?.[0]?.id || null;
  // Membership mutations are project-specific. Remounting the stateful body on
  // a project switch prevents even the first pre-effect render from carrying a
  // typed email, confirmation, mutation, or error into the next project.
  return <CollaboratorsProject key={activeProjectId || 'no-project'} {...props} activeProjectId={activeProjectId} />;
}

function CollaboratorsProject({ currentWs, userId, refreshProjects, activeProjectId }) {
  const activeProject = currentWs?.projects?.find(project => project.id === activeProjectId) || null;
  const cachedActorRole = activeProject?.role || null;
  const activeProjectRef = useRef(activeProjectId);
  const loadRequestRef = useRef(0);
  const mountedRef = useRef(true);
  activeProjectRef.current = activeProjectId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [observedActor, setObservedActor] = useState({ projectId: activeProjectId, role: cachedActorRole });
  const actorRole = observedActor.projectId === activeProjectId ? observedActor.role : cachedActorRole;
  const canManage = actorRole === 'owner' || actorRole === 'admin';
  const availableAddRoles = actorRole === 'owner' ? ROLES : ROLES.filter(role => role !== 'owner');

  const [memberResult, setMemberResult] = useState({ projectId: null, rows: [] });
  const members = memberResult.projectId === activeProjectId ? memberResult.rows : [];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [mutation, setMutation] = useState(null);
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState('viewer');
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(null);
  const mutationInProgress = Boolean(mutation);
  const interactionBlocked = loading || mutationInProgress;

  useEffect(() => {
    loadRequestRef.current += 1;
    setMemberResult({ projectId: activeProjectId, rows: [] });
    setObservedActor({ projectId: activeProjectId, role: cachedActorRole });
    setConfirmRemoveKey(null);
    setMutation(null);
    setLoading(false);
    setEmail('');
    setNewRole('viewer');
    setError(null);
  }, [activeProjectId, cachedActorRole]);

  const loadMembers = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const projectId = activeProjectId;
    if (!activeProjectId) {
      setMemberResult({ projectId: null, rows: [] });
      setLoading(false);
      setError(null);
      return;
    }
    const api = window.electronAPI || {};
    if (!api.listProjectMembers) {
      setMemberResult({ projectId, rows: [] });
      setObservedActor({ projectId, role: null });
      setLoading(false);
      setError('Project members are temporarily unavailable.');
      return;
    }
    setLoading(true);
    setMemberResult({ projectId, rows: [] });
    setError(null);
    try {
      const rows = await api.listProjectMembers(activeProjectId);
      if (activeProjectRef.current !== projectId || loadRequestRef.current !== requestId) return;
      const nextRows = Array.isArray(rows) ? rows : [];
      setMemberResult({ projectId, rows: nextRows });
      if (userId != null) {
        const currentMember = nextRows.find(member => Number(member.userId) === Number(userId));
        const currentRole = currentMember?.role || null;
        setObservedActor({ projectId, role: currentRole });
        if (currentRole !== cachedActorRole && typeof refreshProjects === 'function') {
          await refreshProjects();
        }
      }
    } catch (err) {
      if (activeProjectRef.current !== projectId || loadRequestRef.current !== requestId) return;
      setMemberResult({ projectId, rows: [] });
      setObservedActor({ projectId, role: null });
      setError(parseError(err, 'Failed to load project members.'));
      if (typeof refreshProjects === 'function') await refreshProjects();
    } finally {
      if (activeProjectRef.current === projectId && loadRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [activeProjectId, cachedActorRole, refreshProjects, userId]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    if (!availableAddRoles.includes(newRole)) setNewRole('viewer');
  }, [availableAddRoles, newRole]);

  const memberCountText = useMemo(() => (
    `${members.length} member${members.length === 1 ? '' : 's'}`
  ), [members.length]);

  const addMember = async event => {
    event.preventDefault();
    const api = window.electronAPI || {};
    const projectId = activeProjectId;
    if (!projectId || !email.trim() || !api.addProjectMember || interactionBlocked) return;
    setMutation('add');
    setError(null);
    try {
      await api.addProjectMember(projectId, email.trim(), newRole);
      if (activeProjectRef.current !== projectId) return;
      setEmail('');
      setNewRole('viewer');
      await loadMembers();
    } catch (err) {
      if (activeProjectRef.current !== projectId) return;
      setError(parseError(err, 'Failed to add project member.'));
      if (typeof refreshProjects === 'function') await refreshProjects();
    } finally {
      if (activeProjectRef.current === projectId) setMutation(null);
    }
  };

  const changeRole = async (member, role) => {
    const api = window.electronAPI || {};
    const projectId = activeProjectId;
    if (!projectId || !api.updateProjectMemberRole || member.role === role || interactionBlocked) return;
    setMutation(`role:${member.userId}`);
    setError(null);
    try {
      await api.updateProjectMemberRole(projectId, member.userId, role);
      if (activeProjectRef.current !== projectId) return;
      await loadMembers();
      if (Number(member.userId) === Number(userId) && typeof refreshProjects === 'function') {
        await refreshProjects();
      }
    } catch (err) {
      if (!mountedRef.current || activeProjectRef.current !== projectId) return;
      const message = parseError(err, 'Failed to update the member role.');
      await loadMembers();
      if (typeof refreshProjects === 'function') await refreshProjects();
      if (!mountedRef.current || activeProjectRef.current !== projectId) return;
      setError(message);
    } finally {
      if (activeProjectRef.current === projectId) setMutation(null);
    }
  };

  const removeMember = async member => {
    const api = window.electronAPI || {};
    const projectId = activeProjectId;
    if (!projectId || !api.removeProjectMember || interactionBlocked) return;
    setMutation(`remove:${member.userId}`);
    setError(null);
    try {
      await api.removeProjectMember(projectId, member.userId);
      if (activeProjectRef.current !== projectId) return;
      setConfirmRemoveKey(null);
      if (Number(member.userId) === Number(userId) && typeof refreshProjects === 'function') {
        await refreshProjects();
      } else {
        await loadMembers();
      }
    } catch (err) {
      if (!mountedRef.current || activeProjectRef.current !== projectId) return;
      const message = parseError(err, 'Failed to remove the project member.');
      await loadMembers();
      if (typeof refreshProjects === 'function') await refreshProjects();
      if (!mountedRef.current || activeProjectRef.current !== projectId) return;
      setError(message);
    } finally {
      if (activeProjectRef.current === projectId) setMutation(null);
    }
  };

  if (!activeProjectId) {
    return (
      <div className="h-full w-full overflow-y-auto bg-background p-8 custom-scrollbar">
        <div className="mx-auto max-w-5xl rounded-lg border border-dashed border-border p-8 text-center">
          <Users size={30} className="mx-auto mb-3 text-textMuted" />
          <h2 className="text-xl font-bold text-text">Select a project</h2>
          <p className="mt-2 text-sm text-textMuted">Membership and roles are scoped to the selected research project.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-background p-8 custom-scrollbar">
      <div className="mx-auto max-w-5xl space-y-7">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
          <div>
            <div className="flex items-center gap-3">
              <Users size={28} className="text-primary" />
              <div>
                <h2 className="text-2xl font-black tracking-tight text-text">Collaborators</h2>
                <p className="mt-1 text-sm text-textMuted">
                  Manage access to <span className="font-bold text-text">{activeProject?.name || 'the selected project'}</span>.
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${roleBadge(actorRole)}`}>Your role: {actorRole || 'unknown'}</span>
              <span className="rounded border border-border px-2 py-0.5 text-[10px] font-bold uppercase text-textMuted">{memberCountText}</span>
            </div>
          </div>
          <button onClick={loadMembers} disabled={interactionBlocked} className="btn btn-secondary inline-flex items-center gap-2 text-sm">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Refresh
          </button>
        </header>

        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-textMuted">
          <div className="mb-1 flex items-center gap-2 font-bold text-text">
            <ShieldCheck size={17} className="text-primary" />
            Collaboration boundary
          </div>
          Members can review project records and authorized results according to role. To continue another researcher&apos;s work, create your own private branch from a saved version.
        </div>

        {error && (
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-danger">
            <div className="flex items-center gap-2 font-bold"><AlertTriangle size={18} /> Request rejected</div>
            <p className="mt-1 text-sm">{error}</p>
          </div>
        )}

        {canManage && (
          <form onSubmit={addMember} className="rounded-lg border border-border bg-surface p-5">
            <div className="mb-4">
              <h3 className="flex items-center gap-2 text-lg font-bold text-text"><UserPlus size={18} className="text-primary" /> Add existing user</h3>
              <p className="mt-1 text-sm text-textMuted">The user must already have an account. This is immediate membership, not an emailed invitation.</p>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_180px_auto]">
              <label className="space-y-1 text-xs font-bold text-textMuted">
                Account email
                <input
                  type="email"
                  required
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  placeholder="researcher@example.org"
                  className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text focus:border-primary focus:outline-none"
                />
              </label>
              <label className="space-y-1 text-xs font-bold text-textMuted">
                Role
                <select value={newRole} onChange={event => setNewRole(event.target.value)} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text">
                  {availableAddRoles.map(role => <option key={role} value={role}>{role}</option>)}
                </select>
              </label>
              <button type="submit" disabled={interactionBlocked || !email.trim()} className="btn btn-primary mt-auto inline-flex items-center justify-center gap-2 text-sm">
                {mutation === 'add' ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
                Add member
              </button>
            </div>
            <p className="mt-3 text-xs text-textMuted">{ROLE_HELP[newRole]}</p>
          </form>
        )}

        <section className="space-y-3">
          <div>
            <h3 className="text-lg font-bold text-text">Project members</h3>
            <p className="mt-1 text-sm text-textMuted">Access is re-checked for every action. Visible controls do not replace those checks.</p>
          </div>

          {loading && members.length === 0 ? (
            <div className="flex h-40 items-center justify-center rounded-lg border border-border bg-surface"><Loader2 size={28} className="animate-spin text-primary" /></div>
          ) : members.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-textMuted">No member list is available.</div>
          ) : (
            <div className="space-y-2">
              {members.map(member => {
                const isOwnerTarget = member.role === 'owner';
                const adminBlocked = actorRole === 'admin' && isOwnerTarget;
                const editable = canManage && !adminBlocked;
                const busy = mutation?.endsWith(`:${member.userId}`);
                const removeKey = `${activeProjectId}:${member.userId}`;
                const confirming = confirmRemoveKey === removeKey;
                const roleOptions = actorRole === 'owner' ? ROLES : ROLES.filter(role => role !== 'owner');
                return (
                  <div key={member.userId} className="rounded-lg border border-border bg-surface p-4">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate font-bold text-text">{member.displayName || member.email}</p>
                          {Number(member.userId) === Number(userId) && <span className="text-xs text-textMuted">(you)</span>}
                          <span className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${roleBadge(member.role)}`}>{member.role}</span>
                        </div>
                        <p className="mt-1 truncate text-sm text-textMuted">{member.email}</p>
                        <p className="mt-2 text-xs text-textMuted">{ROLE_HELP[member.role]}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          aria-label={`Role for ${member.email}`}
                          value={member.role}
                          disabled={!editable || interactionBlocked}
                          onChange={event => changeRole(member, event.target.value)}
                          className="rounded border border-border bg-background px-2 py-2 text-sm text-text disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {(roleOptions.includes(member.role) ? roleOptions : [member.role, ...roleOptions]).map(role => <option key={role} value={role}>{role}</option>)}
                        </select>
                        {confirming ? (
                          <div className="flex items-center gap-2">
                            <button aria-label={`Confirm remove ${member.email} from ${activeProject?.name || 'this project'}`} onClick={() => removeMember(member)} disabled={interactionBlocked} className="btn border-danger/40 bg-danger/10 text-xs text-danger hover:bg-danger/20">Confirm remove</button>
                            <button aria-label={`Keep ${member.email}`} onClick={() => setConfirmRemoveKey(null)} disabled={interactionBlocked} className="btn btn-secondary text-xs">Keep</button>
                          </div>
                        ) : (
                          <button
                            aria-label={`Remove ${member.email}`}
                            onClick={() => setConfirmRemoveKey(removeKey)}
                            disabled={!editable || interactionBlocked}
                            className="btn btn-secondary inline-flex items-center gap-2 text-xs text-danger disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
