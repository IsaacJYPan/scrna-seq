import React from 'react';
import { ShieldCheck, Users } from 'lucide-react';

export default function Collaborators({ currentWs }) {
  return (
    <div className="h-full w-full bg-background p-8 overflow-y-auto custom-scrollbar">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="border-b border-border pb-6">
          <div className="flex items-center gap-3">
            <Users size={28} className="text-primary" />
            <div>
              <h2 className="text-2xl font-black tracking-tight text-text">Collaborators</h2>
              <p className="mt-1 text-sm text-textMuted">Project member and RBAC APIs exist in the backend, but this UI is not wired to manage them.</p>
            </div>
          </div>
        </header>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-5">
          <div className="mb-2 inline-flex rounded border border-amber-500/30 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-400">
            Backend-only foundation
          </div>
          <h3 className="text-lg font-bold text-text">No collaborator changes from this screen</h3>
          <p className="mt-2 text-sm leading-relaxed text-textMuted">
            The old demo invite form has been disabled because it did not create real project membership, roles, or access-control changes.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-surface p-5">
          <div className="mb-3 flex items-center gap-2 font-bold text-text">
            <ShieldCheck size={18} className="text-primary" />
            Current boundary
          </div>
          <ul className="space-y-2 text-sm text-textMuted">
            <li>Workspace name: <span className="font-mono text-slate-300">{currentWs?.name || 'Unknown'}</span></li>
            <li>Project metadata visibility does not grant live R object access.</li>
            <li>Shared mutable project live R state is not implemented.</li>
            <li>Real project member management should use the tested backend RBAC routes in a separate branch.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
