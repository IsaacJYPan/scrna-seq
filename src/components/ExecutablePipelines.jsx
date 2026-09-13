import React, { useEffect, useRef, useState } from 'react';
import { Download, Play, Trash2, Upload } from 'lucide-react';
import {
  installPipeline,
  MAX_PIPELINE_FILE_BYTES,
  MAX_INSTALLED_PIPELINES,
  parseExecutablePipeline,
  pipelineRunScript,
  validateExecutablePipeline,
} from '../pipelines/executablePipeline';
import { downloadPipeline, readPipelineFile } from '../pipelines/pipelineFiles';
import { publicErrorMessage } from '../publicError';

function readInstalled(key) {
  if (!key) return { pipelines: [], error: '' };
  try {
    const items = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(items) || items.length > MAX_INSTALLED_PIPELINES) throw new Error('Invalid library');
    return { pipelines: items.map(validateExecutablePipeline), error: '' };
  } catch {
    return {
      pipelines: [],
      error:
        'The saved pipeline library could not be read. Reimport your pipeline files to restore it.',
    };
  }
}

export default function ExecutablePipelines({
  userEmail,
  userId,
  projectId,
  selectedObject,
  canWriteProject,
  deploymentPolicy,
  unsavedLiveChanges,
  onSubmitted,
  setActiveTab,
}) {
  const storageKey = userEmail ? `traceomics:pipelines:${userEmail}` : null;
  const [library, setLibrary] = useState(() => readInstalled(storageKey));
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const mounted = useRef(true);
  const fileInput = useRef(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const profile = deploymentPolicy.expertRProfile;
  const enabled = deploymentPolicy.expertREnabled === true;
  const ownsObject =
    selectedObject?.projectId === projectId &&
    Number(userId) > 0 &&
    Number(selectedObject?.ownerUserId) === Number(userId);

  const saveLibrary = (pipelines) => {
    try {
      if (!storageKey) throw new Error('Account unavailable');
      localStorage.setItem(storageKey, JSON.stringify(pipelines));
      setLibrary({ pipelines, error: '' });
      return true;
    } catch {
      setLibrary((current) => ({
        ...current,
        error:
          'Pipelines could not be saved in this browser. Check its storage settings or export a copy.',
      }));
      return false;
    }
  };
  const importFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setPending(null);
    setBusy(true);
    try {
      if (file.size > MAX_PIPELINE_FILE_BYTES) throw new Error('Pipeline file exceeds 48 KiB.');
      const pipeline = parseExecutablePipeline(await readPipelineFile(file));
      if (mounted.current) {
        setPending(pipeline);
        setLibrary((current) => ({ ...current, error: '' }));
      }
    } catch (error) {
      if (mounted.current) setLibrary((current) => ({ ...current, error: error.message }));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const install = () => {
    try {
      if (saveLibrary(installPipeline(library.pipelines, pending))) setPending(null);
    } catch (error) {
      setLibrary((current) => ({ ...current, error: error.message }));
    }
  };
  const run = async (pipeline) => {
    if (
      busy ||
      !enabled ||
      !ownsObject ||
      !canWriteProject ||
      unsavedLiveChanges ||
      profile?.id !== pipeline.runtime.profileId
    )
      return;
    setBusy(true);
    setSubmitted(false);
    setLibrary((current) => ({ ...current, error: '' }));
    try {
      const validated = validateExecutablePipeline(pipeline);
      const job = await window.electronAPI.createProjectJob(projectId, {
        jobType: 'expert.r.v1',
        analysisObjectId: selectedObject.id,
        parameters: {
          profileId: validated.runtime.profileId,
          script: pipelineRunScript(validated),
          inputIds: [],
        },
      });
      if (mounted.current) {
        setSubmitted(true);
        onSubmitted?.(job.id);
      }
    } catch (error) {
      if (mounted.current)
        setLibrary((current) => ({
          ...current,
          error: publicErrorMessage(
            error,
            'The pipeline could not start. Check your saved analysis and try again.'
          ),
        }));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-border bg-surface/50 p-5"
      aria-labelledby="installed-pipelines-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="installed-pipelines-heading" className="text-lg font-semibold text-text">
            Installed R pipelines
          </h3>
          <p className="mt-1 text-sm text-textMuted">
            Import a versioned pipeline file, then run it on a saved analysis. Installed files stay
            in this browser for your account.
          </p>
        </div>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy || !storageKey}
          className="btn btn-secondary inline-flex items-center gap-2 text-sm"
        >
          <Upload size={15} />
          Import pipeline
        </button>
        <input
          ref={fileInput}
          aria-label="Pipeline package file"
          type="file"
          accept=".json"
          onChange={importFile}
          className="hidden"
        />
      </div>
      {!enabled && (
        <p className="mt-3 text-sm text-textMuted">
          {deploymentPolicy.demoMode
            ? 'The public demo runs built-in pipelines only.'
            : 'Running imported code requires Advanced analysis access on a private deployment.'}{' '}
          You can still install and export pipeline files here.
        </p>
      )}
      {enabled && (!ownsObject || !canWriteProject || unsavedLiveChanges) && (
        <p className="mt-3 text-sm text-textMuted">
          Select a saved analysis you own in a project you can edit. Save any pending analysis
          changes before running a pipeline.
        </p>
      )}
      {library.error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {library.error}
        </p>
      )}
      {pending && (
        <div className="mt-4 rounded-lg border border-primary/30 p-4">
          <h4 className="font-semibold text-text">
            {pending.name} <span className="font-normal text-textMuted">v{pending.version}</span>
          </h4>
          <p className="mt-1 text-sm text-textMuted">{pending.description}</p>
          <p className="mt-2 text-xs text-textMuted">
            This file contains R code. Installation does not run it; a run can read the saved
            analysis you select.
          </p>
          <details className="mt-3 text-sm text-textMuted">
            <summary className="cursor-pointer">View source</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 text-xs">
              {pending.script}
            </pre>
          </details>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={install} className="btn btn-primary text-sm">
              Install version {pending.version}
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="btn btn-secondary text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {library.pipelines.length === 0 && !pending && (
        <p className="mt-5 text-sm text-textMuted">
          No R pipelines installed. Import a .pipeline.json file to get started.
        </p>
      )}
      <div className="mt-4 divide-y divide-border">
        {library.pipelines.map((pipeline) => (
          <article
            key={`${pipeline.id}@${pipeline.version}`}
            className="flex flex-wrap items-center justify-between gap-3 py-4"
          >
            <div className="min-w-0">
              <h4 className="font-medium text-text">
                {pipeline.name} <span className="text-xs text-textMuted">v{pipeline.version}</span>
              </h4>
              <p className="mt-1 text-sm text-textMuted">{pipeline.description}</p>
              {enabled && pipeline.runtime.profileId !== profile?.id && (
                <p className="mt-1 text-xs text-textMuted">
                  This version needs a different R package profile.
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => run(pipeline)}
                disabled={
                  busy ||
                  !enabled ||
                  !ownsObject ||
                  !canWriteProject ||
                  unsavedLiveChanges ||
                  pipeline.runtime.profileId !== profile?.id
                }
                className="btn btn-primary inline-flex items-center gap-2 text-sm"
              >
                <Play size={14} />
                Run {pipeline.name}
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadPipeline(pipeline, `${pipeline.id}-${pipeline.version}.pipeline.json`)
                }
                className="btn btn-secondary"
                aria-label={`Export ${pipeline.name} version ${pipeline.version}`}
              >
                <Download size={15} />
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => saveLibrary(library.pipelines.filter((item) => item !== pipeline))}
                className="btn btn-secondary"
                aria-label={`Remove ${pipeline.name} version ${pipeline.version}`}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {submitted && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p role="status" className="text-sm text-success">
            Pipeline submitted. Its results will appear in Runs &amp; Results.
          </p>
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className="btn btn-secondary text-sm"
          >
            View results
          </button>
        </div>
      )}
    </section>
  );
}
