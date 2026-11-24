import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { publicErrorMessage } from '../publicError';
import PageHeader from '../components/PageHeader';
import RefreshButton from '../components/RefreshButton';
import {
  ConditionsForm,
  BiologicalSamples,
  SampleMappings,
  ComparisonForm,
  SavedContrasts,
} from '../components/StudyDesignForms';
import { findRecordedSampleDesign, planIsEmpty, planRecordedSampleImport } from '../studyDesignImport';

function errorMessage(error) {
  if (error?.code === 'UNSUPPORTED_CONDITION_MODEL') {
    return 'Adjusted condition models are not available yet. This release supports only ~ condition, or ~ donor + condition for paired donors.';
  }
  if (error?.code === 'METADATA_VALUE_ALREADY_BOUND') {
    return 'This metadata group is already mapped to a biological sample. One metadata value cannot represent multiple independent samples. Load a multi-sample analysis or use a metadata column that distinguishes samples.';
  }
  if (error?.code === 'SAMPLE_ALREADY_BOUND') {
    return 'This biological sample is already mapped to this analysis. Choose a different sample or review the existing mapping.';
  }
  return publicErrorMessage(
    error,
    'Study-design operation failed. Review the settings and try again.'
  );
}

export default function StudyDesign({ currentWs, datasetInfo, userId, callApi }) {
  const formId = useId();
  const selectIds = {
    savedVersion: `${formId}-saved-version`,
    sampleCondition: `${formId}-sample-condition`,
    modality: `${formId}-modality`,
    boundSample: `${formId}-bound-sample`,
    numeratorCondition: `${formId}-numerator-condition`,
    denominatorCondition: `${formId}-denominator-condition`,
    replicationUnit: `${formId}-replication-unit`,
  };
  const projectId =
    datasetInfo?.projectId || currentWs?.selectedProjectId || currentWs?.projects?.[0]?.id || null;
  const activeProject = (currentWs?.projects || []).find((project) => project.id === projectId);
  const canWriteStudyDesign = ['owner', 'admin', 'analyst'].includes(activeProject?.role);
  const objects = useMemo(
    () => (currentWs?.objects || []).filter((object) => object.projectId === projectId),
    [currentWs?.objects, projectId]
  );
  const [conditions, setConditions] = useState([]);
  const [samples, setSamples] = useState([]);
  const [contrasts, setContrasts] = useState([]);
  const [bindings, setBindings] = useState([]);
  const [bindingsContext, setBindingsContext] = useState(null);
  const designRequestRef = useRef(0);
  const [objectId, setObjectId] = useState(datasetInfo?.id || '');
  const mappingsReady =
    bindingsContext?.projectId === projectId && bindingsContext?.objectId === objectId;
  const [conditionName, setConditionName] = useState('');
  const [sample, setSample] = useState({
    name: '',
    conditionId: '',
    donorCode: '',
    batch: '',
    modality: 'scrna',
  });
  const [binding, setBinding] = useState({
    sampleId: '',
    cellMetadataColumn: 'orig.ident',
    cellMetadataValue: '',
  });
  const emptyContrast = {
    name: '',
    numeratorConditionId: '',
    denominatorConditionId: '',
    unitOfReplication: 'sample',
    paired: false,
    cellTypeColumn: 'seurat_clusters',
  };
  const [contrast, setContrast] = useState(emptyContrast);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [conditionComparisonStarted, setConditionComparisonStarted] = useState(false);
  const [singleSampleWarning, setSingleSampleWarning] = useState(null);
  const [contrastResults, setContrastResults] = useState({});
  // Contrast id -> time its latest run was queued from this page, so the status
  // is shown beside the button that started it.
  const [pendingRuns, setPendingRuns] = useState({});

  // Newest completed pseudobulk summary per contrast, from the job's own
  // summary artifact (the complete table stays an audited download).
  const loadContrastResults = useCallback(async () => {
    const api = window.electronAPI;
    if (!projectId || !api?.listProjectJobs || !api?.listProjectJobArtifacts) return;
    try {
      const [completedJobs, failedJobs] = await Promise.all([
        api.listProjectJobs(projectId, { jobType: 'condition.pseudobulk_de.v1', status: 'completed' }),
        api.listProjectJobs(projectId, { jobType: 'condition.pseudobulk_de.v1', status: 'failed' }).catch(() => []),
      ]);
      const jobs = [...(Array.isArray(completedJobs) ? completedJobs : []), ...(Array.isArray(failedJobs) ? failedJobs : [])];
      const newest = new Map();
      for (const job of jobs) {
        const contrastId = job?.parameters?.contrastId;
        if (!contrastId) continue;
        const previous = newest.get(contrastId);
        if (!previous || String(job.completedAt || job.createdAt) > String(previous.completedAt || previous.createdAt)) {
          newest.set(contrastId, job);
        }
      }
      const entries = await Promise.all([...newest.entries()].map(async ([contrastId, job]) => {
        // A newer failed run is reported beside its contrast, with the reason.
        if (job.status === 'failed') {
          return [contrastId, { jobId: job.id, completedAt: job.completedAt || job.updatedAt || job.createdAt,
            failure: publicErrorMessage(job.error, 'The latest run did not finish. Open Runs & Results for details.') }];
        }
        const artifacts = await api.listProjectJobArtifacts(projectId, job.id).catch(() => []);
        const summaryArtifact = (Array.isArray(artifacts) ? artifacts : [])
          .find((artifact) => artifact.artifactType === 'condition_de_summary');
        const summary = summaryArtifact?.metadata?.summary;
        return summary ? [contrastId, { jobId: job.id, completedAt: job.completedAt, summary }] : null;
      }));
      setContrastResults(Object.fromEntries(entries.filter(Boolean)));
    } catch {
      // Results are a convenience view; the design itself stays usable.
    }
  }, [projectId]);

  useEffect(() => { void loadContrastResults(); }, [loadContrastResults, contrasts]);
  useEffect(() => {
    if (!conditionComparisonStarted) return undefined;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      void loadContrastResults();
      if (polls >= 60) clearInterval(timer);
    }, 5000);
    return () => clearInterval(timer);
  }, [conditionComparisonStarted, loadContrastResults]);

  const refresh = useCallback(async () => {
    if (!projectId || !window.electronAPI?.listStudyConditions) return;
    const request = ++designRequestRef.current;
    setBindingsContext(null);
    setSingleSampleWarning(null);
    setBusy('refresh');
    setError('');
    try {
      const [nextConditions, nextSamples, nextContrasts, nextBindings] = await Promise.all([
        window.electronAPI.listStudyConditions(projectId),
        window.electronAPI.listBiologicalSamples(projectId),
        window.electronAPI.listConditionContrasts(projectId),
        objectId ? window.electronAPI.listAnalysisObjectSampleBindings(projectId, objectId) : [],
      ]);
      if (request !== designRequestRef.current) return;
      setConditions(nextConditions || []);
      setSamples(nextSamples || []);
      setContrasts(nextContrasts || []);
      setBindings(nextBindings || []);
      setBindingsContext({ projectId, objectId });
    } catch (loadError) {
      if (request === designRequestRef.current) setError(errorMessage(loadError));
    } finally {
      if (request === designRequestRef.current) setBusy('');
    }
  }, [objectId, projectId]);

  useEffect(() => {
    void refresh();
    return () => {
      designRequestRef.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    if (datasetInfo?.id) setObjectId(datasetInfo.id);
  }, [datasetInfo?.id]);
  useEffect(() => {
    let cancelled = false;
    setSingleSampleWarning(null);
    const workspaceSelected = objects.find((object) => object.id === objectId);
    const selected =
      datasetInfo?.id === objectId
        ? { ...(workspaceSelected || {}), ...datasetInfo }
        : workspaceSelected;
    const canInspectPrivateObject =
      datasetInfo?.id === objectId &&
      bindingsContext?.projectId === projectId &&
      bindingsContext?.objectId === objectId &&
      selected?.liveState === 'attached' &&
      Number(selected?.ownerUserId) === Number(userId) &&
      typeof callApi === 'function';
    if (!canInspectPrivateObject)
      return () => {
        cancelled = true;
      };

    const mappedColumns = [
      ...new Set(bindings.map((item) => item.cellMetadataColumn).filter(Boolean)),
    ];
    // Mixed-column mappings are validated by the saved contrast rather than this single-column hint.
    if (mappedColumns.length > 1)
      return () => {
        cancelled = true;
      };
    const column = mappedColumns[0] || 'orig.ident';
    void callApi('/meta-values?column=' + encodeURIComponent(column))
      .then((result) => {
        if (!cancelled) setSingleSampleWarning(Number(result?.n_unique) === 1 ? column : null);
      })
      .catch(() => {
        if (!cancelled) setSingleSampleWarning(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bindings, bindingsContext, callApi, datasetInfo, objectId, objects, projectId, userId]);

  const mutate = async (key, action) => {
    if (!canWriteStudyDesign || busy) return;
    setBusy(key);
    setError('');
    try {
      await action();
      await refresh();
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setBusy('');
    }
  };

  const recordedDesign = useMemo(() => findRecordedSampleDesign(objects, objectId), [objects, objectId]);
  const recordedPlan = useMemo(
    () => (mappingsReady ? planRecordedSampleImport({ recorded: recordedDesign, conditions, samples, bindings }) : null),
    [mappingsReady, recordedDesign, conditions, samples, bindings]
  );

  const importRecordedSamples = () => {
    if (!recordedDesign || !recordedPlan || planIsEmpty(recordedPlan)) return;
    void mutate('import-samples', async () => {
      const api = window.electronAPI;
      for (const name of recordedPlan.conditionsToCreate) {
        await api.createStudyCondition(projectId, { name });
      }
      const currentConditions = await api.listStudyConditions(projectId);
      const conditionIdByName = new Map(
        (currentConditions || []).map((item) => [item.name.trim().toLocaleLowerCase('en-US'), item.id])
      );
      for (const row of recordedPlan.samplesToCreate) {
        await api.createBiologicalSample(projectId, {
          name: row.name,
          conditionId: conditionIdByName.get(row.conditionName.toLocaleLowerCase('en-US')),
          donorCode: row.donorCode,
          batch: row.batch,
          modality: 'scrna',
        });
      }
      const currentSamples = await api.listBiologicalSamples(projectId);
      const sampleIdByName = new Map(
        (currentSamples || []).map((item) => [item.name.trim().toLocaleLowerCase('en-US'), item.id])
      );
      for (const row of recordedPlan.bindingsToCreate) {
        await api.bindSampleToAnalysisObject(projectId, objectId, {
          sampleId: sampleIdByName.get(row.sampleName.toLocaleLowerCase('en-US')),
          cellMetadataColumn: row.cellMetadataColumn,
          cellMetadataValue: row.cellMetadataValue,
        });
      }
    });
  };

  const createCondition = (event) => {
    event.preventDefault();
    if (!conditionName.trim()) return;
    void mutate('condition', async () => {
      await window.electronAPI.createStudyCondition(projectId, { name: conditionName.trim() });
      setConditionName('');
    });
  };

  const createSample = (event) => {
    event.preventDefault();
    if (!sample.name.trim() || !sample.conditionId) return;
    void mutate('sample', async () => {
      await window.electronAPI.createBiologicalSample(projectId, {
        ...sample,
        name: sample.name.trim(),
      });
      setSample({ name: '', conditionId: '', donorCode: '', batch: '', modality: 'scrna' });
    });
  };

  const createBinding = (event) => {
    event.preventDefault();
    if (
      !objectId ||
      !binding.sampleId ||
      !binding.cellMetadataColumn.trim() ||
      !binding.cellMetadataValue.trim()
    )
      return;
    void mutate('binding', async () => {
      await window.electronAPI.bindSampleToAnalysisObject(projectId, objectId, binding);
      setBinding({
        sampleId: '',
        cellMetadataColumn: binding.cellMetadataColumn,
        cellMetadataValue: '',
      });
    });
  };

  const createContrast = (event) => {
    event.preventDefault();
    if (
      !objectId ||
      !contrast.name.trim() ||
      !contrast.numeratorConditionId ||
      !contrast.denominatorConditionId
    )
      return;
    void mutate('contrast', async () => {
      await window.electronAPI.createConditionContrast(projectId, {
        ...contrast,
        name: contrast.name.trim(),
        analysisObjectId: objectId,
      });
      setContrast(emptyContrast);
    });
  };

  const runContrast = (item) =>
    void mutate(`run-${item.id}`, async () => {
      setConditionComparisonStarted(false);
      await window.electronAPI.createProjectJob(projectId, {
        jobType: 'condition.pseudobulk_de.v1',
        analysisObjectId: item.analysisObjectId,
        parameters: { contrastId: item.id },
      });
      setPendingRuns((previous) => ({ ...previous, [item.id]: new Date().toISOString() }));
      setConditionComparisonStarted(true);
    });

  if (!projectId)
    return <div className="p-8 text-slate-400">Select a project to define its study design.</div>;

  return (
    <div className="page-scroll custom-scrollbar text-text">
      <div className="page-column space-y-5">
        <PageHeader
          title="Study Design"
          icon={FlaskConical}
          titleAction={<RefreshButton onClick={() => void refresh()} disabled={!!busy} />}
        />
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300"
          >
            {error}
          </div>
        )}
        {!canWriteStudyDesign && (
          <div className="panel text-sm text-textMuted">
            Study design is read-only for your project role. An owner, administrator, or analyst can
            change conditions, samples, mappings, and comparisons.
          </div>
        )}
        {singleSampleWarning && (
          <div
            role="status"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
          >
            This analysis contains one <code>{singleSampleWarning}</code> group. Map cells through a
            metadata column that distinguishes independent biological samples before condition-level
            inference.
          </div>
        )}
        {conditionComparisonStarted && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
            Condition comparison started. Track it in Runs &amp; Results.
          </div>
        )}
        <div className="block text-sm">
          <label className="block" htmlFor={selectIds.savedVersion}>
            Saved version
          </label>
          <select
            id={selectIds.savedVersion}
            className="input mt-1 w-full max-w-md"
            value={objectId}
            onChange={(event) => setObjectId(event.target.value)}
          >
            <option value="">Select a saved version</option>
            {objects.map((object) => (
              <option key={object.id} value={object.id}>
                {object.displayName || object.name || 'Saved version'}
              </option>
            ))}
          </select>
        </div>

        {recordedDesign && recordedPlan && (
          <section
            className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm"
            aria-labelledby={`${formId}-recorded-heading`}
            data-testid="recorded-sample-import"
          >
            <h2 id={`${formId}-recorded-heading`} className="font-bold text-text">
              Samples recorded when this analysis was prepared
            </h2>
            <p className="mt-1 text-textMuted">
              {recordedDesign.samples.length} samples across{' '}
              {new Set(recordedDesign.samples.map((row) => row.conditionName.toLocaleLowerCase('en-US'))).size}{' '}
              conditions, identified by the <code>{recordedDesign.sampleColumn}</code> column.
            </p>
            {planIsEmpty(recordedPlan) ? (
              <p className="mt-2 text-textMuted">These samples are already registered and mapped for this saved version.</p>
            ) : (
              <>
                <p className="mt-2 text-textMuted">
                  Adds {recordedPlan.conditionsToCreate.length} condition(s), {recordedPlan.samplesToCreate.length} sample(s)
                  {' '}and {recordedPlan.bindingsToCreate.length} cell mapping(s). Existing entries are kept unchanged.
                </p>
                <button
                  type="button"
                  className="btn btn-primary mt-3 text-sm"
                  onClick={importRecordedSamples}
                  disabled={!canWriteStudyDesign || !!busy}
                >
                  {busy === 'import-samples' ? 'Adding samples…' : 'Use recorded samples'}
                </button>
              </>
            )}
            {recordedPlan.conflicts.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-amber-700 dark:text-amber-300">
                {recordedPlan.conflicts.map((message) => <li key={message}>{message}</li>)}
              </ul>
            )}
          </section>
        )}

        <fieldset disabled={!canWriteStudyDesign} className="space-y-4 min-w-0">
          <ConditionsForm
            conditions={conditions}
            conditionName={conditionName}
            setConditionName={setConditionName}
            busy={busy}
            onSubmit={createCondition}
          />

          <BiologicalSamples
            formId={formId}
            samples={samples}
            conditions={conditions}
            sample={sample}
            setSample={setSample}
            selectIds={selectIds}
            busy={busy}
            onSubmit={createSample}
          />

          <SampleMappings
            binding={binding}
            setBinding={setBinding}
            samples={samples}
            selectIds={selectIds}
            busy={busy}
            objectId={objectId}
            mappingsReady={mappingsReady}
            bindings={bindings}
            onSubmit={createBinding}
          />

          <ComparisonForm
            contrast={contrast}
            setContrast={setContrast}
            conditions={conditions}
            selectIds={selectIds}
            busy={busy}
            objectId={objectId}
            onSubmit={createContrast}
          />
        </fieldset>

        <SavedContrasts
          contrasts={contrasts}
          canWriteStudyDesign={canWriteStudyDesign}
          busy={busy}
          runContrast={runContrast}
          results={contrastResults}
          pendingRuns={pendingRuns}
          versionNames={Object.fromEntries(objects.map((object) => [object.id, object.displayName || object.name || '']))}
        />
      </div>
    </div>
  );
}
