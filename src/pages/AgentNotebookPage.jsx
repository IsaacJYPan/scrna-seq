import React from 'react';
import { NotebookPen } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import AgentNotebook from '../components/AgentNotebook';

// The project's agent notebook as its own destination.
export default function AgentNotebookPage({ currentWs, theme, setActiveTab }) {
  const projectId = currentWs?.selectedProjectId || currentWs?.projects?.[0]?.id || null;
  const project = currentWs?.projects?.find((p) => p.id === projectId) || null;
  return (
    <div className="h-full w-full overflow-y-auto bg-background p-4 sm:p-8 custom-scrollbar">
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title="Agent notebook" icon={NotebookPen} className="border-b border-border pb-5"
          description={<>What delegated agents did in <span className="font-bold text-text">{project?.name || 'this project'}</span>, step by step.</>} />
        {projectId
          ? <AgentNotebook key={projectId} projectId={projectId} role={project?.role || null} theme={theme} onOpenTab={setActiveTab} />
          : <p className="text-sm text-textMuted">Select a project first.</p>}
      </div>
    </div>
  );
}
