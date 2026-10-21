import React, { useCallback, useRef, useState } from 'react';
import { artifactBytesLabel } from '../artifacts/privateRArtifactPolicy';
import { TARGET_DISCONNECTED_MESSAGE } from '../runtime/executionTarget';
import ExecutionTargetEvidence from './ExecutionTargetEvidence';
import usePrivateRSession, { terminalStatuses } from './r-console/usePrivateRSession';
import Output from './r-console/RCommandOutput';
import { SavedPreview, SaveOutputForm, SavedOutputs } from './r-console/RArtifactPanels';
import {
  RequestRecovery,
  SessionIdentity,
  CommandJournal,
  PreviousSession,
} from './r-console/RSessionPanels';

const initialCell = () => ({
  id: crypto.randomUUID(),
  name: 'Cell 1',
  source: '# Variables persist in this private session.\nn <- 3\nn',
});

export default function RConsole({
  projectId,
  userId,
  workspaceId,
  objects = [],
  preferredObjectId = '',
  deploymentPolicy = {},
}) {
  const [cells, setCells] = useState(() => [initialCell()]);
  const [cellIndex, setCellIndex] = useState(0);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const editor = useRef(null);
  const current = cells[cellIndex] || cells[0];
  const resetEditor = useCallback(() => {
    setCells([initialCell()]);
    setCellIndex(0);
    setSelection({ start: 0, end: 0 });
  }, []);
  const {
    blocked,
    enabled,
    error,
    setError,
    inspecting,
    inspected,
    uncertain,
    controlNotice,
    runningCommand,
    retainedRequests,
    forgetRequest,
    setForgetRequest,
    busy,
    controlBusy,
    refresh,
    forget,
    artifactPolicy,
    active,
    objectId,
    selectObject,
    recoveryBlocked,
    restartPending,
    session,
    environment,
    start,
    interruptSupported,
    canInterrupt,
    interrupt,
    confirmRestart,
    setConfirmRestart,
    canRestart,
    restart,
    restartReceipt,
    confirmStop,
    setConfirmStop,
    stop,
    versions,
    selectedInputs,
    toggleInput,
    execute,
    publicationUncertain,
    entry,
    publicationSupported,
    chooseFigure,
    publish,
    publicationForm,
    setPublicationForm,
    figureSelection,
    replacements,
    saving,
    canSaveFigure,
    canSaveBinding,
    publications,
    inspectSaved,
    savedPreview,
    setSavedPreview,
    journal,
    openEntry,
    journalCursor,
    loadOlder,
    previousEvidence,
    inspectPrevious,
  } = usePrivateRSession({
    projectId,
    userId,
    workspaceId,
    deploymentPolicy,
    onResetDrafts: resetEditor,
  });
  const edit = (value) => {
    setCells((items) =>
      items.map((cell, index) => (index === cellIndex ? { ...cell, source: value } : cell))
    );
    setSelection({ start: 0, end: 0 });
  };
  const copySource = () => {
    if (typeof entry?.source !== 'string') return;
    setCells((items) => [
      ...items,
      { id: crypto.randomUUID(), name: `Cell ${items.length + 1}`, source: entry.source },
    ]);
    setCellIndex(cells.length);
    setSelection({ start: 0, end: 0 });
  };
  return (
    <section
      aria-label="Private R console"
      className="rounded-xl border border-border bg-surface text-text p-4 space-y-4"
    >
      <div>
        <h2 className="text-lg font-semibold">Private R console</h2>
        <p className="text-sm text-textMuted">
          Run free R cells or selected source. Variables persist inside your isolated session;
          stopping discards unsaved memory and files.
        </p>
      </div>
      {blocked && (
        <p role="status" className="rounded border border-amber-300 p-3 text-sm">
          {TARGET_DISCONNECTED_MESSAGE} Previously confirmed results remain visible. Reconnect to
          inspect whether pending work completed; no command is rerun automatically.
        </p>
      )}
      {!enabled && (
        <p role="status">
          {deploymentPolicy.demoMode
            ? 'Private R sessions are unavailable in the public demo.'
            : !projectId
              ? 'Choose a project to use the console.'
              : 'Persistent R sessions require execution access and a runtime with private kernel support. Existing one-shot R remains available in supported deployments.'}
        </p>
      )}
      {error && (
        <div role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {enabled && inspecting && (
        <p role="status" className="rounded border border-border p-3 text-sm">
          Checking the private R session. Commands and saves wait for fresh server confirmation.
        </p>
      )}
      {enabled && session && !blocked && !inspecting && !inspected && (
        <p role="status" className="rounded border border-amber-300 p-3 text-sm">
          Session inspection is unconfirmed. Previous results remain visible; inspect status before
          running or saving.
        </p>
      )}
      {uncertain && (
        <p role="status" className="rounded border border-amber-300 p-3 text-sm">
          Completion or memory availability is unknown. Refresh status to inspect the retained
          command. No analysis will be rerun automatically.
        </p>
      )}
      {controlNotice && (
        <p role="status" className="rounded border border-border p-3 text-sm">
          {controlNotice}
        </p>
      )}
      {enabled && runningCommand && (
        <p role="status" className="rounded border border-border p-3 text-sm">
          R command is running or awaiting confirmation. Session controls remain available.
        </p>
      )}
      {enabled && retainedRequests.length > 0 && (
        <RequestRecovery
          retainedRequests={retainedRequests}
          blocked={blocked}
          inspecting={inspecting}
          controlBusy={controlBusy}
          busy={busy}
          refresh={refresh}
          setForgetRequest={setForgetRequest}
          forgetRequest={forgetRequest}
          forget={forget}
        />
      )}
      {enabled && (
        <>
          <div
            aria-label="Private R artifact limits"
            className="rounded border border-border p-3 text-xs space-y-2"
          >
            {artifactPolicy ? (
              <>
                <p>
                  Current service limits: {artifactBytesLabel(artifactPolicy.maxOutputBytes)} per
                  saved file · {artifactBytesLabel(artifactPolicy.maxInputFileBytes)} per input file
                  · {artifactBytesLabel(artifactPolicy.maxInputTotalBytes)} selected inputs total.
                  Managed artifact quota: {artifactBytesLabel(artifactPolicy.managedQuotaBytes)}.
                </p>
                <details>
                  <summary className="cursor-pointer">Storage and transfer limits</summary>
                  <p className="pt-2">
                    Saves retain a {artifactBytesLabel(artifactPolicy.diskReserveBytes)} free disk
                    reserve. Large artifact transfers may take up to{' '}
                    {artifactPolicy.transferTimeoutSeconds} seconds. The service checks current
                    capacity and quota for each save.
                  </p>
                </details>
              </>
            ) : (
              <p>
                Saved-file limits are unavailable. The service checks artifact size, storage
                capacity, and quota when saving.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {!active && (
              <>
                <label className="text-sm">
                  Initial saved analysis
                  <select
                    aria-label="Initial saved analysis"
                    value={objectId}
                    onChange={(event) => selectObject(event.target.value)}
                    disabled={busy || controlBusy}
                    className="block border border-border rounded p-2 bg-surface text-text"
                  >
                    <option value="">Empty R session</option>
                    {objects.map((object) => (
                      <option key={object.id} value={object.id}>
                        {object.displayName || object.name || object.id}
                        {object.id === preferredObjectId ? ' · current' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="btn btn-primary"
                  disabled={
                    !inspected ||
                    inspecting ||
                    blocked ||
                    busy ||
                    controlBusy ||
                    recoveryBlocked ||
                    restartPending ||
                    (session?.restart && session.restart.status !== 'failed') ||
                    !environment
                  }
                  onClick={start}
                >
                  Start private session
                </button>
              </>
            )}
            <button
              className="btn btn-secondary"
              disabled={blocked || controlBusy || inspecting}
              onClick={() => refresh()}
            >
              Refresh session status
            </button>
            {interruptSupported && session && (
              <button className="btn btn-secondary" disabled={!canInterrupt} onClick={interrupt}>
                Interrupt R command
              </button>
            )}
            {session && !confirmRestart && (
              <button
                className="btn btn-secondary"
                disabled={!canRestart}
                onClick={() => setConfirmRestart(true)}
              >
                Restart session
              </button>
            )}
            {confirmRestart && (
              <>
                <span className="text-sm">
                  Restart discards unsaved variables and files, reloads the original selected input
                  versions, and does not rerun earlier commands. Saved artifact versions remain
                  available.
                </span>
                <button
                  className="btn btn-secondary"
                  disabled={!canRestart}
                  onClick={() => restart()}
                >
                  Restart and discard unsaved memory
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={controlBusy}
                  onClick={() => setConfirmRestart(false)}
                >
                  Keep current session
                </button>
              </>
            )}
            {((restartPending &&
              restartReceipt &&
              !['completed', 'failed'].includes(restartReceipt.status)) ||
              session?.restart ||
              (session?.restartedFromKernelId &&
                ['starting', 'unknown'].includes(session.status))) && (
              <button
                className="btn btn-secondary"
                disabled={blocked || controlBusy}
                onClick={() => restart(true)}
              >
                Inspect restart request
              </button>
            )}
            {active && !confirmStop && (
              <button
                className="btn btn-secondary"
                disabled={blocked || controlBusy}
                onClick={() => setConfirmStop(true)}
              >
                Stop session
              </button>
            )}
            {confirmStop && (
              <>
                <span className="text-sm">Unsaved variables and files will be lost.</span>
                <button
                  className="btn btn-secondary"
                  disabled={blocked || controlBusy}
                  onClick={stop}
                >
                  Stop and discard unsaved memory
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={controlBusy}
                  onClick={() => setConfirmStop(false)}
                >
                  Keep session
                </button>
              </>
            )}
          </div>
          {!active && versions.length > 0 && (
            <fieldset className="rounded border border-border p-3 space-y-2">
              <legend className="text-sm">Saved input versions · select up to five</legend>
              {versions.map((version) => {
                const duplicateName = versions.some(
                  (other) => other.versionId !== version.versionId && other.name === version.name
                );
                const versionLabel = duplicateName
                  ? ` · v${version.versionNumber || version.versionId}`
                  : '';
                return (
                  <label key={version.versionId} className="flex gap-2 text-xs items-start">
                    <input
                      type="checkbox"
                      aria-label={`Use ${version.name}${versionLabel}`}
                      checked={selectedInputs.includes(version.versionId)}
                      disabled={
                        busy ||
                        (selectedInputs.length >= 5 && !selectedInputs.includes(version.versionId))
                      }
                      onChange={(event) => toggleInput(version.versionId, event.target.checked)}
                    />
                    <span>
                      {version.name}
                      {version.versionNumber ? ` · v${version.versionNumber}` : ''} ·{' '}
                      {version.format.id} · {artifactBytesLabel(version.sizeBytes)}
                      <span className="block font-mono break-all">{version.sha256}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
          {session && <SessionIdentity session={session} />}
          {inspected && terminalStatuses.includes(session?.status) && (
            <p role="status" className="rounded border border-border p-3 text-sm">
              This session no longer has unsaved memory. Earlier journal source and saved versions
              remain available. Start a new session explicitly; earlier commands will not run
              automatically.
            </p>
          )}
          {session?.target && <ExecutionTargetEvidence target={session.target} />}
          <div className="flex flex-wrap gap-2">
            {cells.map((cell, index) => (
              <button
                className="btn btn-secondary text-xs"
                aria-pressed={index === cellIndex}
                key={cell.id}
                onClick={() => {
                  setCellIndex(index);
                  setSelection({ start: 0, end: 0 });
                }}
              >
                {cell.name}
              </button>
            ))}
            <button
              className="btn btn-secondary text-xs"
              onClick={() => {
                setCells((items) => [
                  ...items,
                  { id: crypto.randomUUID(), name: `Cell ${items.length + 1}`, source: '' },
                ]);
                setCellIndex(cells.length);
                setSelection({ start: 0, end: 0 });
              }}
            >
              Add R cell
            </button>
          </div>
          <label className="block text-sm">
            {current.name} source
            <textarea
              ref={editor}
              aria-label="R console source"
              className="block w-full min-h-48 rounded border border-border bg-surface text-text p-3 font-mono text-sm"
              spellCheck={false}
              value={current.source}
              onChange={(event) => edit(event.target.value)}
              onSelect={(event) =>
                setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd })
              }
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn btn-primary"
              disabled={
                !inspected ||
                inspecting ||
                blocked ||
                busy ||
                controlBusy ||
                recoveryBlocked ||
                runningCommand ||
                session?.status !== 'ready' ||
                uncertain ||
                publicationUncertain ||
                !current.source.trim()
              }
              onClick={() => execute(current.source)}
            >
              Run R cell
            </button>
            <button
              className="btn btn-secondary"
              disabled={
                !inspected ||
                inspecting ||
                blocked ||
                busy ||
                controlBusy ||
                recoveryBlocked ||
                runningCommand ||
                session?.status !== 'ready' ||
                uncertain ||
                publicationUncertain ||
                selection.start === selection.end
              }
              onClick={() => execute(current.source.slice(selection.start, selection.end))}
            >
              Run selected R
            </button>
            <span className="text-xs text-textMuted">
              32 KiB source limit · private command history · table and PNG previews
            </span>
          </div>
          {!interruptSupported && session && (
            <p className="text-xs text-textMuted">
              This runtime cannot interrupt commands. Stop or restart explicitly to discard unsaved
              memory.
            </p>
          )}
          <Output
            entry={entry}
            canPublish={
              inspected &&
              !inspecting &&
              !blocked &&
              !recoveryBlocked &&
              publicationSupported &&
              !busy &&
              !controlBusy &&
              !publicationUncertain &&
              (!entry?.kernelId || entry.kernelId === session?.id)
            }
            onFigure={chooseFigure}
            onCopy={copySource}
          />
          {publicationSupported && session && (
            <SaveOutputForm
              publish={publish}
              publicationForm={publicationForm}
              busy={busy}
              setPublicationForm={setPublicationForm}
              figureSelection={figureSelection}
              replacements={replacements}
              inspected={inspected}
              inspecting={inspecting}
              blocked={blocked}
              saving={saving}
              controlBusy={controlBusy}
              recoveryBlocked={recoveryBlocked}
              publicationUncertain={publicationUncertain}
              canSaveFigure={canSaveFigure}
              canSaveBinding={canSaveBinding}
            />
          )}
          {!publicationSupported && (
            <p role="status" className="text-sm">
              Saving R outputs requires a runtime with publication support. Upgrade the pinned
              private runtime to enable object, table, and figure saves.
            </p>
          )}
          {publications.length > 0 && (
            <SavedOutputs
              publications={publications}
              blocked={blocked}
              busy={busy}
              inspectSaved={inspectSaved}
            />
          )}
          <SavedPreview
            projectId={projectId}
            value={savedPreview}
            onImageError={() => {
              setSavedPreview(null);
              setError('The saved figure is unavailable or its checksum verification failed.');
            }}
          />
          {journal.length > 0 && (
            <CommandJournal
              journal={journal}
              openEntry={openEntry}
              blocked={blocked}
              busy={busy}
              inspecting={inspecting}
              journalCursor={journalCursor}
              controlBusy={controlBusy}
              loadOlder={loadOlder}
            />
          )}
          {(previousEvidence?.kernelId || session?.restartedFromKernelId) && (
            <PreviousSession
              previousEvidence={previousEvidence}
              session={session}
              blocked={blocked}
              busy={busy}
              controlBusy={controlBusy}
              inspectPrevious={inspectPrevious}
              openEntry={openEntry}
              inspectSaved={inspectSaved}
            />
          )}
          <p className="text-xs text-textMuted">
            Source, command order, environment, and console previews are saved privately. Variables
            and files remain unsaved; console previews are not published scientific artifact
            versions until explicitly saved. Untracked intermediate state leaves replay history
            incomplete.
          </p>
        </>
      )}
    </section>
  );
}
