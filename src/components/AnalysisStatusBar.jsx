import React from 'react';
import DetailsPopover from './DetailsPopover';
import { Info } from 'lucide-react';

const PHASE_LABEL = {
  saving: 'Saving live analysis…', opening: 'Opening saved analysis…',
  pending: 'Save awaiting confirmation', completed: 'Analysis saved', error: 'Analysis could not be saved',
};

export default function AnalysisStatusBar({ datasetInfo, unsavedLiveChanges, checkpointSaveState, checkpointSaveBusy, onSave, onOpenHistory }) {
  if (!datasetInfo) return null;
  const phase = checkpointSaveState.phase;
  const liveAttached = datasetInfo.liveState === 'attached';
  const savedButNotOpened = phase === 'error' && checkpointSaveState.durableSaved;
  const status = savedButNotOpened ? 'Saved; opening failed' : PHASE_LABEL[phase] || (unsavedLiveChanges ? 'Unsaved live changes.' : liveAttached ? 'Live analysis' : 'Saved analysis selected');
  const attention = unsavedLiveChanges || phase === 'error' || phase === 'pending';
  return <section aria-label="Analysis status" className={`shrink-0 h-16 border-b border-border px-4 flex items-center justify-between gap-3 ${attention ? 'bg-amber-500/10' : 'bg-surface'}`}>
    <div className="min-w-0 flex-1">
      <p role="status" className="truncate text-sm font-semibold text-text" title={status}>{status}</p>
      <p className="truncate text-xs text-textMuted" title={datasetInfo.displayName || datasetInfo.name}>{datasetInfo.displayName || datasetInfo.name || 'Selected analysis'}</p>
    </div>
    <div className="shrink-0 flex items-center gap-2">
      <DetailsPopover label={<><Info size={16} aria-hidden="true" /><span className="sr-only sm:not-sr-only">Status details</span></>}>
        {phase !== 'idle' && <p className="mb-3" role={phase === 'error' ? 'alert' : undefined}>{checkpointSaveState.message}</p>}
        {unsavedLiveChanges ? <>
          <p>Closing this window or restarting compute can discard unsaved changes.</p>
          <p className="mt-2">Queued analyses use the saved version. Save the current analysis to include these changes in queued work.</p>
        </> : <p>{liveAttached ? 'This is your private live workspace. Save after making changes to create a durable version for queued analyses.' : 'This saved version is available for review. Open it in your private workspace from Runs & Results to continue analysis.'}</p>}
        {(phase === 'pending' || phase === 'error' || !liveAttached) && <button type="button" data-close-popover className="btn btn-secondary mt-3" onClick={onOpenHistory}>Review saved versions</button>}
      </DetailsPopover>
      {!savedButNotOpened && (liveAttached || unsavedLiveChanges) ? <button type="button" className="btn btn-primary" disabled={!unsavedLiveChanges || checkpointSaveBusy} onClick={onSave} aria-label="Save current analysis">{checkpointSaveBusy ? 'Saving…' : 'Save'}</button>
        : <button type="button" className="btn btn-secondary" aria-label="Open saved analysis from Runs & Results" onClick={onOpenHistory}>Open</button>}
    </div>
  </section>;
}
