import SeuratPipelineSettings from './SeuratPipelineSettings';
import React, { useState } from 'react';
import { FileUp, Zap, Loader2, RefreshCw, Archive } from 'lucide-react';
import { mapBackendAnalysisObject } from '../backendWorkspaceModel';
import { publicErrorMessage } from '../publicError';
import RefreshButton from './RefreshButton';
import { displayRunStatus, formatDate, parseErrorMessage, researcherRunNote } from './analysisRunDisplay';

function datasetResearchStatus(dataset) {
  if (dataset?.uploadStatus === 'failed' || dataset?.validationStatus === 'invalid') return 'Needs attention';
  if (dataset?.uploadStatus === 'uploaded' && dataset?.validationStatus === 'valid') return 'Ready for analysis';
  if (dataset?.uploadStatus === 'uploaded') return 'Checking data';
  return 'Preparing data';
}

const CLASSIC_VISIUM_REQUIRED_FILES = [
  'filtered_feature_bc_matrix.h5',
  'spatial/tissue_positions.csv or spatial/tissue_positions_list.csv',
  'spatial/scalefactors_json.json',
  'spatial/tissue_lowres_image.png',
];

const MAX_MULTI_SAMPLE_INPUTS = 48;
const SAFE_MULTI_SAMPLE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

function isValidMultiSampleLabel(value, { optional = false } = {}) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return optional;
  return normalized.length <= 80 && SAFE_MULTI_SAMPLE_LABEL_PATTERN.test(normalized);
}

function datasetValidationMessages(dataset) {
  const value = dataset?.validationErrors;
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').slice(0, 4);
  if (value && typeof value === 'object' && Array.isArray(value.errors)) {
    return value.errors.filter((item) => typeof item === 'string').slice(0, 4);
  }
  return [];
}

function defaultSampleName(dataset) {
  const raw = String(dataset?.originalFilename || dataset?.name || 'sample')
    .replace(/\.h5$/i, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')
    .trim()
    .slice(0, 80);
  return /^[A-Za-z0-9]/.test(raw) ? raw : `sample_${raw}`.slice(0, 80);
}

// Removed API constant
// ── Load Object Modal ──────────────────────────────────────────────

function StatusPill({ label, tone = 'slate' }) {
  const tones = {
    green: 'bg-success/10 text-success border-success/30',
    blue: 'bg-primary/10 text-text border-primary/20',
    amber: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
    slate: 'bg-slate-800 text-slate-300 border-slate-700',
  };
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold ${tones[tone] || tones.slate}`}>
      {label}
    </span>
  );
}

function safeMessage(value) {
  return String(value || '')
    .replace(/[A-Za-z]:[\\/][^\s'")]+/g, '[redacted path]')
    .replace(/\/__private_vault__\/[^\s'")]+/g, '[redacted path]')
    .replace(/\bvault\/[^\s'")]+/gi, '[redacted storage]')
    .replace(/\bstorage_?(uri|key)\b/gi, '[redacted storage field]')
    .replace(/\bclaim_?token\b/gi, '[redacted worker field]')
    .replace(/\bstate_?key\b/gi, '[redacted state field]')
    .replace(/\buser-\d+:obj-[A-Za-z0-9_-]+/g, '[redacted state]');
}

function isSupportedTenxH5File(file) {
  return !!file?.name && /\.h5$/i.test(file.name);
}

function isSupportedClassicVisiumZipFile(file) {
  return !!file?.name && /\.zip$/i.test(file.name);
}

const DEFAULT_SEURAT_PIPELINE_PARAMS = Object.freeze({
  minCells: 3,
  minFeatures: 200,
  applyQcFilter: true,
  minFeaturesFilter: 200,
  maxFeaturesFilter: 2500,
  maxPercentMt: 5,
  normalizationMethod: 'LogNormalize',
  scaleFactor: 10000,
  variableFeatures: 2000,
  pcaDims: 50,
  clusterDims: 15,
  clusterResolution: 0.8,
  umapDims: 15,
  umapComponents: 2,
  umapNeighbors: 30,
  umapMinDist: 0.3,
  seed: null,
});

const SEURAT_NUMERIC_CONTROLS = Object.freeze([
  { key: 'minCells', label: 'Min cells', min: 0, max: 10000, step: 1 },
  { key: 'minFeatures', label: 'Min features', min: 0, max: 100000, step: 1 },
  { key: 'minFeaturesFilter', label: 'QC min features', min: 0, max: 100000, step: 1 },
  { key: 'maxFeaturesFilter', label: 'QC max features', min: 1, max: 1000000, step: 1 },
  { key: 'maxPercentMt', label: 'Max percent MT', min: 0, max: 100, step: 0.1 },
  { key: 'scaleFactor', label: 'Scale factor', min: 1, max: 10000000, step: 1 },
  { key: 'variableFeatures', label: 'Variable features', min: 50, max: 10000, step: 1 },
  { key: 'pcaDims', label: 'PCA dims', min: 2, max: 100, step: 1 },
  { key: 'clusterDims', label: 'Cluster dims', min: 2, max: 100, step: 1 },
  { key: 'clusterResolution', label: 'Cluster resolution', min: 0.01, max: 10, step: 0.01 },
  { key: 'umapDims', label: 'UMAP dims', min: 2, max: 100, step: 1 },
  { key: 'umapNeighbors', label: 'UMAP neighbors', min: 2, max: 200, step: 1 },
  { key: 'umapMinDist', label: 'UMAP min dist', min: 0, max: 1, step: 0.01 },
]);

function datasetDisplayName(dataset) {
  return dataset?.originalFilename || dataset?.name || dataset?.id || 'Dataset';
}

function rawDatasetObjectName(dataset) {
  const base = datasetDisplayName(dataset).replace(/\.[^.]+$/, '');
  return `${base} raw input`;
}

function scrubEmptyParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== '') out[key] = value !== null && (key === 'seed' || key === 'umapComponents' || SEURAT_NUMERIC_CONTROLS.some(control => control.key === key))
      ? Number(value) : value;
  }
  return out;
}

export function SeuratPipelinePanel({
  activeProjectId,
  selectedObject,
  currentWs,
  updateActiveWorkspace,
  onSelectAnalysisObject,
  setActiveTab,
  datasetUploadsEnabled = true,
  canWriteProject = false,
}) {
  const [analysisApproach, setAnalysisApproach] = useState('automatic');
  const approachId = React.useId();
  const [workflowMode, setWorkflowMode] = useState('scrna');
  const [datasets, setDatasets] = useState([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [multiSampleRows, setMultiSampleRows] = useState([]);
  const [datasetStatus, setDatasetStatus] = useState({ loading: false, uploading: false, error: null });
  const [job, setJob] = useState(null);
  const [loadJob, setLoadJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [jobStatus, setJobStatus] = useState({ launching: false, refreshing: false, error: null });
  // Compute target for Seurat runs: the installation worker, or the Slurm
  // cluster when this installation has one configured and reachable.
  const [runTarget, setRunTarget] = useState('local');
  const [slurmTarget, setSlurmTarget] = useState(null);
  React.useEffect(() => {
    let active = true;
    setSlurmTarget(null);
    setRunTarget('local');
    const api = window.electronAPI || {};
    if (!activeProjectId || typeof api.listComputeTargets !== 'function') return undefined;
    api.listComputeTargets(activeProjectId).then((result) => {
      const slurm = (result?.targets || []).find((target) => target.name === 'slurm');
      if (active && slurm?.available) setSlurmTarget(slurm);
    }).catch(() => {});
    return () => { active = false; };
  }, [activeProjectId]);
  const [loadStatus, setLoadStatus] = useState({ launching: false, refreshing: false, error: null });
  const [params, setParams] = useState(() => ({ ...DEFAULT_SEURAT_PIPELINE_PARAMS }));

  const spatialMode = workflowMode === 'spatial';
  const multiSampleMode = workflowMode === 'multisample';
  const workflow = spatialMode ? {
    datasetFileType: 'visium_zip',
    jobType: 'spatial.seurat.v1',
    sourceType: 'classic_visium_dataset',
    formatLabel: 'classic 10x Visium Space Ranger ZIP bundle',
    shortFormatLabel: 'Visium ZIP',
  } : multiSampleMode ? {
    datasetFileType: 'tenx_h5',
    jobType: 'seurat.multisample.v1',
    sourceType: 'tenx_h5_multisample_dataset',
    formatLabel: 'two or more 10x Genomics filtered feature-barcode matrix HDF5 files (.h5)',
    shortFormatLabel: 'Multi-sample 10x HDF5',
  } : {
    datasetFileType: 'tenx_h5',
    jobType: 'seurat.pipeline.v1',
    sourceType: 'tenx_h5_dataset',
    formatLabel: '10x Genomics filtered feature-barcode matrix HDF5 (.h5)',
    shortFormatLabel: '10x HDF5',
  };

  const activeDataset = datasets.find(dataset => dataset.id === selectedDatasetId) || null;
  const selectedMultiDatasets = multiSampleRows.map(row => datasets.find(dataset => dataset.id === row.datasetId));
  const activeDatasetReady = multiSampleMode
    ? selectedMultiDatasets.length >= 2 && selectedMultiDatasets.every(dataset => (
      dataset?.uploadStatus === 'uploaded' && dataset?.validationStatus === 'valid'
    ))
    : activeDataset?.uploadStatus === 'uploaded' && activeDataset?.validationStatus === 'valid';
  const multiSampleConditionCounts = multiSampleRows.reduce((counts, row) => {
    const condition = String(row.conditionName || '').trim().toLocaleLowerCase('en-US');
    if (condition) counts.set(condition, (counts.get(condition) || 0) + 1);
    return counts;
  }, new Map());
  const multiSampleDesignValid = multiSampleRows.length >= 2
    && multiSampleRows.length <= MAX_MULTI_SAMPLE_INPUTS
    && multiSampleRows.every(row => (
      isValidMultiSampleLabel(row.sampleName)
      && isValidMultiSampleLabel(row.conditionName)
      && isValidMultiSampleLabel(row.donorCode, { optional: true })
      && isValidMultiSampleLabel(row.batch, { optional: true })
    ))
    && new Set(multiSampleRows.map(row => String(row.sampleName || '').trim().toLocaleLowerCase('en-US'))).size === multiSampleRows.length
    && multiSampleConditionCounts.size >= 2;
  const inputObjects = (currentWs.objects || [])
    .filter(object => object.projectId === activeProjectId && object.datasetId === selectedDatasetId);
  const selectedInputObject = selectedObject?.projectId === activeProjectId && selectedObject?.datasetId === selectedDatasetId
    ? selectedObject
    : null;
  const inputObject = selectedInputObject || inputObjects[0] || null;
  const resultObjectId = job?.resultAnalysisObjectId || artifacts.find(a => a.resultAnalysisObjectId)?.resultAnalysisObjectId || null;
  const resultObject = (currentWs.objects || []).find(object => object.id === resultObjectId) || null;
  const checkpointArtifact = artifacts.find(artifact => /checkpoint/i.test(artifact.artifactType || artifact.type || '')) || null;
  const summaryArtifact = artifacts.find(artifact => /summary|inspect/i.test(artifact.artifactType || artifact.type || '')) || null;
  const safeSummary = summaryArtifact?.metadata?.summary || summaryArtifact?.metadata?.objectSummary || job?.summary || null;
  const warnings = [
    ...(Array.isArray(job?.warnings) ? job.warnings : []),
    ...(Array.isArray(summaryArtifact?.metadata?.warnings) ? summaryArtifact.metadata.warnings : []),
  ];
  const checkpointAttached = (loadJob?.status === 'completed' && loadJob.analysisObjectId === resultObjectId) || resultObject?.liveState === 'attached';
  const loadCompleted = checkpointAttached;
  const loadJobErrorMessage = loadJob?.status === 'failed'
    ? publicErrorMessage(loadJob.error, 'Opening this saved version needs attention.')
    : null;
  const canContinueToDeg = Boolean(resultObjectId && checkpointAttached);
  const guidedReady = selectedObject?.projectId === activeProjectId && selectedObject?.liveState === 'attached';
  const hasRunActivity = Boolean(job || loadJob || jobStatus.launching || jobStatus.error || loadStatus.error);
  const changeApproachWithKeys = event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'automatic' : event.key === 'End' ? 'guided' : analysisApproach === 'automatic' ? 'guided' : 'automatic';
    setAnalysisApproach(next);
    document.getElementById(`${approachId}-${next}-tab`)?.focus();
  };
  const openGuidedStep = route => {
    if (!guidedReady) return;
    onSelectAnalysisObject?.(activeProjectId, selectedObject.id);
    setActiveTab?.(route);
  };
  const inspectPipelineResult = () => {
    if (!canContinueToDeg) return;
    onSelectAnalysisObject?.(activeProjectId, resultObjectId);
    setActiveTab?.('qc');
  };

  const loadDatasets = React.useCallback(async () => {
    if (!activeProjectId) {
      setDatasets([]);
      setSelectedDatasetId('');
      return;
    }
    const api = window.electronAPI || {};
    if (!api.listDatasets) return;
    setDatasetStatus(prev => ({ ...prev, loading: true, error: null }));
    try {
      const rows = await api.listDatasets(activeProjectId, { fileType: workflow.datasetFileType });
      const next = Array.isArray(rows) ? rows : [];
      setDatasets(next);
      if (multiSampleMode) {
        setMultiSampleRows(prev => prev.filter(row => next.some(dataset => dataset.id === row.datasetId)));
      } else {
        setSelectedDatasetId(prev => (next.some(dataset => dataset.id === prev) ? prev : (next[0]?.id || '')));
      }
    } catch (error) {
      setDatasetStatus(prev => ({ ...prev, error: parseErrorMessage(error) }));
    } finally {
      setDatasetStatus(prev => ({ ...prev, loading: false }));
    }
  }, [activeProjectId, multiSampleMode, workflow.datasetFileType]);

  React.useEffect(() => {
    loadDatasets();
  }, [loadDatasets]);

  const upsertWorkspaceObject = React.useCallback((backendObject, { select = false, liveResult = {} } = {}) => {
    if (!backendObject?.id || typeof updateActiveWorkspace !== 'function') return null;
    const mapped = backendObject.isBackendAnalysisObject ? backendObject : mapBackendAnalysisObject(backendObject, liveResult);
    const nextObjects = [mapped, ...(currentWs.objects || []).filter(object => object.id !== mapped.id)];
    const updates = { objects: nextObjects };
    if (select) {
      updates.selectedObjectIds = [mapped.id];
      updates.lastSelectedByProject = {
        ...(currentWs.lastSelectedByProject || {}),
        [activeProjectId]: mapped.id,
      };
    }
    updateActiveWorkspace(updates);
    return mapped;
  }, [activeProjectId, currentWs.lastSelectedByProject, currentWs.objects, updateActiveWorkspace]);

  const ensureDatasetInputObject = async () => {
    if (inputObject?.id) return inputObject;
    const api = window.electronAPI || {};
    if (!api.createProjectAnalysisObject) {
      throw new Error('Preparing the input file is temporarily unavailable.');
    }
    const created = await api.createProjectAnalysisObject(activeProjectId, {
      datasetId: selectedDatasetId,
      objectType: 'matrix',
      displayName: rawDatasetObjectName(activeDataset),
      metadata: {
        source: 'dataset',
        sourceType: workflow.sourceType,
        datasetId: selectedDatasetId,
        fileType: activeDataset?.fileType || workflow.datasetFileType,
        supportedWorkflow: workflow.jobType,
        scientific_output: false,
      },
    });
    return upsertWorkspaceObject(created) || mapBackendAnalysisObject(created);
  };

  const refreshJob = React.useCallback(async (jobId = job?.id) => {
    if (!activeProjectId || !jobId) return;
    const api = window.electronAPI || {};
    if (!api.getProjectJob || !api.getProjectJobLogs || !api.listProjectJobArtifacts) return;
    setJobStatus(prev => ({ ...prev, refreshing: true, error: null }));
    try {
      const [nextJob, logResponse, nextArtifacts] = await Promise.all([
        api.getProjectJob(activeProjectId, jobId),
        api.getProjectJobLogs(activeProjectId, jobId),
        api.listProjectJobArtifacts(activeProjectId, jobId),
      ]);
      setJob(nextJob || null);
      setLogs(Array.isArray(logResponse?.logs) ? logResponse.logs : []);
      setArtifacts(Array.isArray(nextArtifacts) ? nextArtifacts : []);
      if (nextJob?.resultAnalysisObjectId && api.getProjectAnalysisObject) {
        try {
          const result = await api.getProjectAnalysisObject(activeProjectId, nextJob.resultAnalysisObjectId);
          upsertWorkspaceObject(result);
        } catch {
          // The job/artifact metadata remains usable even if the optional UI cache refresh fails.
        }
      }
    } catch (error) {
      setJobStatus(prev => ({ ...prev, error: parseErrorMessage(error) }));
    } finally {
      setJobStatus(prev => ({ ...prev, refreshing: false }));
    }
  }, [activeProjectId, job?.id, upsertWorkspaceObject]);

  React.useEffect(() => {
    if (!job?.id || !['queued', 'running'].includes(job.status) || jobStatus.refreshing) return undefined;
    const timer = window.setTimeout(() => refreshJob(job.id), 2500);
    return () => window.clearTimeout(timer);
  }, [job?.id, job?.status, jobStatus.refreshing, refreshJob]);

  const uploadDataset = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!canWriteProject) {
      setDatasetStatus(prev => ({ ...prev, error: 'Your project role is read-only and cannot upload input files.' }));
      return;
    }
    if (files.length === 0) return;
    const selectedFiles = multiSampleMode ? files : files.slice(0, 1);
    if (multiSampleMode && multiSampleRows.length + selectedFiles.length > MAX_MULTI_SAMPLE_INPUTS) {
      setDatasetStatus({
        loading: false,
        uploading: false,
        error: `A multi-condition run supports at most ${MAX_MULTI_SAMPLE_INPUTS} sample datasets.`,
      });
      return;
    }
    const unsupported = selectedFiles.some(file => (
      spatialMode ? !isSupportedClassicVisiumZipFile(file) : !isSupportedTenxH5File(file)
    ));
    if (unsupported) {
      setDatasetStatus({
        loading: false,
        uploading: false,
        error: spatialMode
          ? 'Unsupported for this pipeline: upload one classic 10x Visium Space Ranger output bundle as a .zip file.'
          : 'Unsupported for this pipeline: upload a 10x Genomics filtered feature-barcode matrix HDF5 file with a .h5 extension.',
      });
      return;
    }
    const api = window.electronAPI || {};
    if (!api.uploadDataset) {
      setDatasetStatus(prev => ({ ...prev, error: 'Uploading input files is temporarily unavailable.' }));
      return;
    }
    setDatasetStatus({ loading: false, uploading: true, error: null });
    try {
      for (const file of selectedFiles) {
        const created = await api.uploadDataset(activeProjectId, file, {
          supportedWorkflow: workflow.jobType,
          supportedFormat: workflow.formatLabel,
        }, workflow.datasetFileType);
        setDatasets(prev => [created, ...prev.filter(dataset => dataset.id !== created.id)]);
        if (multiSampleMode) {
          setMultiSampleRows(prev => prev.some(row => row.datasetId === created.id) ? prev : [...prev, {
            datasetId: created.id,
            sampleName: defaultSampleName(created),
            conditionName: '',
            donorCode: '',
            batch: '',
          }]);
          setSelectedDatasetId(prev => prev || created.id);
        } else {
          setSelectedDatasetId(created.id);
        }
      }
    } catch (error) {
      setDatasetStatus(prev => ({ ...prev, error: parseErrorMessage(error) }));
    } finally {
      setDatasetStatus(prev => ({ ...prev, uploading: false }));
    }
  };

  const launchPipeline = async () => {
    if (!canWriteProject) {
      setJobStatus(prev => ({ ...prev, error: 'Your project role is read-only and cannot start analysis jobs.' }));
      return;
    }
    if (!activeProjectId || !selectedDatasetId) return;
    const api = window.electronAPI || {};
    const createJob = spatialMode
      ? api.createSpatialSeuratPipelineJob
      : multiSampleMode
        ? api.createMultiSampleSeuratPipelineJob
        : api.createSeuratPipelineJob;
    if (!createJob) {
      setJobStatus(prev => ({ ...prev, error: 'This approved workflow is temporarily unavailable.' }));
      return;
    }
    setJobStatus({ launching: true, refreshing: false, error: null });
    setLoadJob(null);
    setLoadStatus({ launching: false, refreshing: false, error: null });
    setLogs([]);
    setArtifacts([]);
    try {
      const input = await ensureDatasetInputObject();
      const created = await createJob(activeProjectId, {
        datasetId: selectedDatasetId,
        ...(multiSampleMode ? { samples: multiSampleRows } : {}),
        analysisObjectId: input.id,
        params: scrubEmptyParams(params),
        ...(!spatialMode && runTarget === 'slurm' ? { executionTarget: 'slurm' } : {}),
      });
      setJob(created);
      await refreshJob(created.id);
    } catch (error) {
      setJobStatus(prev => ({ ...prev, error: parseErrorMessage(error) }));
    } finally {
      setJobStatus(prev => ({ ...prev, launching: false }));
    }
  };

  const refreshLoadJob = React.useCallback(async (jobId = loadJob?.id) => {
    if (!activeProjectId || !jobId) return;
    const api = window.electronAPI || {};
    if (!api.getProjectJob) return;
    setLoadStatus(prev => ({ ...prev, refreshing: true, error: null }));
    try {
      const nextJob = await api.getProjectJob(activeProjectId, jobId);
      setLoadJob(nextJob || null);
      if (nextJob?.status === 'completed' && resultObjectId) {
        const existing = (currentWs.objects || []).find(object => object.id === resultObjectId);
        if (existing) upsertWorkspaceObject({ ...existing, liveState: 'attached' });
      }
    } catch (error) {
      setLoadStatus(prev => ({ ...prev, error: parseErrorMessage(error) }));
    } finally {
      setLoadStatus(prev => ({ ...prev, refreshing: false }));
    }
  }, [activeProjectId, currentWs.objects, loadJob?.id, resultObjectId, upsertWorkspaceObject]);

  React.useEffect(() => {
    if (!loadJob?.id || !['queued', 'running'].includes(loadJob.status) || loadStatus.refreshing) return undefined;
    const timer = window.setTimeout(() => refreshLoadJob(loadJob.id), 2500);
    return () => window.clearTimeout(timer);
  }, [loadJob?.id, loadJob?.status, loadStatus.refreshing, refreshLoadJob]);

  const loadCheckpoint = async () => {
    if (!activeProjectId || !resultObjectId) return;
    const api = window.electronAPI || {};
    if (!api.createProjectJob) {
      setLoadStatus(prev => ({ ...prev, error: 'Opening a saved version is temporarily unavailable.' }));
      return;
    }
    setLoadStatus({ launching: true, refreshing: false, error: null });
    try {
      const created = await api.createProjectJob(activeProjectId, {
        jobType: 'checkpoint.load.v1',
        analysisObjectId: resultObjectId,
        parameters: {},
      });
      setLoadJob(created);
      await refreshLoadJob(created.id);
    } catch (error) {
      setLoadStatus(prev => ({ ...prev, error: parseErrorMessage(error) }));
    } finally {
      setLoadStatus(prev => ({ ...prev, launching: false }));
    }
  };

  const continueToDeg = () => {
    if (!canContinueToDeg) return;
    onSelectAnalysisObject?.(activeProjectId, resultObjectId);
    setActiveTab('deg');
  };

  const canLaunch = canWriteProject && !!activeProjectId && !!selectedDatasetId && !jobStatus.launching
    && (!spatialMode || activeDatasetReady)
    && (!multiSampleMode || (activeDatasetReady && multiSampleDesignValid));

  const selectWorkflowMode = (nextMode) => {
    if (nextMode === workflowMode) return;
    setWorkflowMode(nextMode);
    setDatasets([]);
    setSelectedDatasetId('');
    setMultiSampleRows([]);
    setJob(null);
    setLoadJob(null);
    setLogs([]);
    setArtifacts([]);
    setDatasetStatus({ loading: false, uploading: false, error: null });
    setJobStatus({ launching: false, refreshing: false, error: null });
    setLoadStatus({ launching: false, refreshing: false, error: null });
  };

  const continueToStudyDesign = () => {
    if (!canContinueToDeg) return;
    onSelectAnalysisObject?.(activeProjectId, resultObjectId);
    setActiveTab('study-design');
  };

  const toggleMultiSampleDataset = (dataset) => {
    const alreadySelected = multiSampleRows.some(row => row.datasetId === dataset.id);
    if (!alreadySelected && multiSampleRows.length >= MAX_MULTI_SAMPLE_INPUTS) {
      setDatasetStatus(prev => ({
        ...prev,
        error: `A multi-condition run supports at most ${MAX_MULTI_SAMPLE_INPUTS} sample datasets.`,
      }));
      return;
    }
    setMultiSampleRows(prev => {
      const exists = prev.some(row => row.datasetId === dataset.id);
      return exists
        ? prev.filter(row => row.datasetId !== dataset.id)
        : [...prev, {
          datasetId: dataset.id,
          sampleName: defaultSampleName(dataset),
          conditionName: '',
          donorCode: '',
          batch: '',
        }];
    });
  };

  const updateMultiSampleRow = (datasetId, field, value) => {
    setMultiSampleRows(prev => prev.map(row => (
      row.datasetId === datasetId ? { ...row, [field]: value } : row
    )));
  };

  React.useEffect(() => {
    if (!multiSampleMode) return;
    setSelectedDatasetId(multiSampleRows[0]?.datasetId || '');
  }, [multiSampleMode, multiSampleRows]);

  return (
    <section data-testid="seurat-pipeline-panel">
      <h3 className="sr-only">Seurat analysis</h3>
      <div className="flex border-b border-border" role="tablist" aria-label="Analysis approach">
        {[['automatic', 'Run whole pipeline'], ['guided', 'Inspect step by step']].map(([mode, label]) => (
          <button key={mode} type="button" role="tab" id={`${approachId}-${mode}-tab`}
            aria-controls={`${approachId}-${mode}-panel`} aria-selected={analysisApproach === mode}
            tabIndex={analysisApproach === mode ? 0 : -1} onKeyDown={changeApproachWithKeys}
            onClick={() => setAnalysisApproach(mode)}
            className={`min-h-12 border-b-2 px-3 py-3 text-sm font-semibold transition-colors sm:px-5 ${analysisApproach === mode ? 'border-primary text-primary' : 'border-transparent text-textMuted hover:text-text hover:border-border'}`}
          >{label}</button>
        ))}
      </div>

      {!activeProjectId ? (
        <div className="mt-5 rounded border border-dashed border-border p-5 text-sm text-textMuted">
          Select or create a project before uploading data or running the Seurat workflow.
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {!canWriteProject && (
            <div className="rounded border border-border bg-surface px-3 py-2 text-sm text-textMuted" role="note">
              This project is read-only for your role. You can review workflow settings and results, but only an owner, administrator, or analyst can upload data or start a run.
            </div>
          )}
          <div role="tabpanel" id={`${approachId}-automatic-panel`} aria-labelledby={`${approachId}-automatic-tab`}
            hidden={analysisApproach !== 'automatic'} className="space-y-4">
            <p className="text-sm text-textMuted">Set every step below, then submit one job from input to UMAP. Inspect the results when it finishes.</p>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3"><span className="text-sm text-textMuted" aria-hidden="true">Data type</span><div className="segmented" role="group" aria-label="Data type">
            <button
              type="button"
              aria-pressed={workflowMode === 'scrna'}
              onClick={() => selectWorkflowMode('scrna')}
              className="segmented-option"
            >
              Single-cell RNA
            </button>
            <button
              type="button"
              aria-pressed={multiSampleMode}
              onClick={() => selectWorkflowMode('multisample')}
              className="segmented-option"
            >
              Multiple conditions
            </button>
            <button
              type="button"
              aria-pressed={spatialMode}
              onClick={() => selectWorkflowMode('spatial')}
              className="segmented-option"
            >
              Spatial transcriptomics (Visium)
            </button>
              </div></div>
            </div>
            <div className="border-t border-border pt-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-1.5">
                    <h4 className="font-semibold text-text">Input files</h4>
                    <RefreshButton onClick={loadDatasets} disabled={datasetStatus.loading} loading={datasetStatus.loading} label="Refresh input files" />
                  </div>
                  <p className="mt-1 text-xs text-textMuted">Supported format: {workflow.formatLabel}.</p>
                  {!(datasetUploadsEnabled && canWriteProject) && <p className="mt-1 text-xs text-textMuted">
                    {canWriteProject ? 'Uploads are turned off on this server.' : 'Read-only project; uploads are disabled for your role.'}
                  </p>}
                  {spatialMode && <p className="mt-1 text-xs text-textMuted">Visium HD and Xenium are not accepted by this workflow.</p>}
                  {multiSampleMode && <p className="mt-1 text-xs text-textMuted">Use one file per biological sample and assign its condition below.</p>}
                </div>
                {datasetUploadsEnabled && canWriteProject ? <label className="btn btn-primary inline-flex cursor-pointer items-center gap-2 text-sm">
                  <FileUp size={16} />
                  {datasetStatus.uploading
                    ? 'Uploading...'
                    : spatialMode
                      ? 'Upload Visium .zip'
                      : multiSampleMode ? 'Upload sample .h5 files' : 'Upload 10x .h5'}
                  <input
                    data-testid="seurat-pipeline-upload"
                    type="file"
                    accept={spatialMode ? '.zip' : '.h5'}
                    multiple={multiSampleMode}
                    className="sr-only"
                    disabled={datasetStatus.uploading || !canWriteProject}
                    onChange={uploadDataset}
                  />
                </label> : null}
              </div>
              {datasetStatus.error && (
                <div className="mb-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {safeMessage(datasetStatus.error)}
                </div>
              )}
              {datasets.length === 0 ? (
                <p className="text-sm text-textMuted">
                  This project has no {workflow.shortFormatLabel} files yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {datasets.map(dataset => {
                    const designRow = multiSampleRows.find(row => row.datasetId === dataset.id);
                    const selected = multiSampleMode ? Boolean(designRow) : selectedDatasetId === dataset.id;
                    return (
                      <div key={dataset.id} className="rounded border border-border bg-surface p-3 hover:border-primary/40">
                        <label className="flex cursor-pointer items-start gap-3">
                          <input
                            type={multiSampleMode ? 'checkbox' : 'radio'}
                            name="seurat-pipeline-dataset"
                            checked={selected}
                            onChange={() => (multiSampleMode
                              ? toggleMultiSampleDataset(dataset)
                              : setSelectedDatasetId(dataset.id))}
                            className="mt-1"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-bold text-text">{dataset.originalFilename || dataset.name || 'Uploaded file'}</span>
                            <span className="mt-1 block text-xs text-textMuted">
                              {workflow.shortFormatLabel} · {datasetResearchStatus(dataset)}
                            </span>
                            {dataset.validationStatus === 'invalid' && (
                              <span className="mt-2 block text-xs text-danger">
                                {datasetValidationMessages(dataset)[0]
                                  ? safeMessage(datasetValidationMessages(dataset)[0])
                                  : 'This upload did not pass format validation.'}
                              </span>
                            )}
                          </span>
                        </label>
                        {multiSampleMode && designRow && (
                          <div className="mt-3 grid grid-cols-1 gap-2 border-t border-border pt-3 sm:grid-cols-2">
                            <label className="text-xs text-textMuted">
                              Sample name
                              <input className="input mt-1 w-full" aria-label={`Sample name for ${dataset.originalFilename || dataset.id}`} value={designRow.sampleName} onChange={event => updateMultiSampleRow(dataset.id, 'sampleName', event.target.value)} />
                            </label>
                            <label className="text-xs text-textMuted">
                              Condition
                              <input className="input mt-1 w-full" aria-label={`Condition for ${dataset.originalFilename || dataset.id}`} placeholder="e.g. treated" value={designRow.conditionName} onChange={event => updateMultiSampleRow(dataset.id, 'conditionName', event.target.value)} />
                            </label>
                            <label className="text-xs text-textMuted">
                              Donor code (optional)
                              <input className="input mt-1 w-full" aria-label={`Donor code for ${dataset.originalFilename || dataset.id}`} value={designRow.donorCode} onChange={event => updateMultiSampleRow(dataset.id, 'donorCode', event.target.value)} />
                            </label>
                            <label className="text-xs text-textMuted">
                              Batch (optional)
                              <input className="input mt-1 w-full" aria-label={`Batch for ${dataset.originalFilename || dataset.id}`} value={designRow.batch} onChange={event => updateMultiSampleRow(dataset.id, 'batch', event.target.value)} />
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="overflow-hidden rounded border border-border bg-surface">
              <h4 className="border-b border-border px-4 py-3 font-semibold text-text sm:px-5">Pipeline settings</h4>
              <SeuratPipelineSettings params={params} setParams={setParams} controls={SEURAT_NUMERIC_CONTROLS} />
              <div className="border-t border-border p-4 sm:p-5">
              {multiSampleMode && (
                <div className="mt-3 rounded border border-primary/20 bg-primary/5 px-3 py-3 text-xs text-textMuted" role="status">
                  <p className="font-bold text-text">Multi-condition preparation</p>
                  <p className="mt-1">
                    {multiSampleRows.length} selected sample{multiSampleRows.length === 1 ? '' : 's'} across {multiSampleConditionCounts.size} condition{multiSampleConditionCounts.size === 1 ? '' : 's'}.
                  </p>
                  {!multiSampleDesignValid && (
                    <p className="mt-2 text-amber-800 dark:text-amber-200">
                      Select 2-{MAX_MULTI_SAMPLE_INPUTS} datasets, enter unique sample names, and assign at least two conditions. Labels must be 1-80 characters and use letters, numbers, spaces, periods, underscores, or hyphens.
                    </p>
                  )}
                  {multiSampleDesignValid && [...multiSampleConditionCounts.values()].some(count => count < 2) && (
                    <p className="mt-2 text-amber-800 dark:text-amber-200">
                      The combined analysis can run, but replicate-aware condition testing requires at least two independent samples in each compared condition.
                    </p>
                  )}
                  {multiSampleDesignValid && [...multiSampleConditionCounts.values()].every(count => count >= 2) && (
                    <p className="mt-2 text-success">
                      The sample counts meet the minimum replication gate for sample-level condition comparisons.
                    </p>
                  )}
                  <p className="mt-2">The saved object will contain <code>sample_id</code>, <code>condition</code>, <code>donor_code</code>, and <code>batch</code> metadata.</p>
                </div>
              )}
              {spatialMode && activeDataset && !activeDatasetReady && (
                <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-xs text-textMuted" role="status">
                  <p className="font-bold text-text">
                    {activeDataset.validationStatus === 'invalid'
                      ? 'This Visium ZIP cannot be started until its contents are corrected.'
                      : 'This Visium ZIP is still being checked. Refresh input files before starting the run.'}
                  </p>
                  <p className="mt-2">Required files under one Space Ranger output directory:</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {CLASSIC_VISIUM_REQUIRED_FILES.map((file) => <li key={file}>{file}</li>)}
                  </ul>
                  {datasetValidationMessages(activeDataset).map((message) => (
                    <p key={message} className="mt-2 text-danger">{safeMessage(message)}</p>
                  ))}
                </div>
              )}
              {slurmTarget && !spatialMode && (
                <label className="mt-4 block space-y-1 text-xs font-bold text-textMuted">Run on
                  <select aria-label="Run on" value={runTarget} onChange={(event) => setRunTarget(event.target.value)}
                    className="w-full max-w-xs rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text">
                    <option value="local">This installation</option>
                    <option value="slurm">Slurm cluster{slurmTarget.partition ? ` (${slurmTarget.partition})` : ''}</option>
                  </select>
                </label>
              )}
              <button
                onClick={launchPipeline}
                disabled={!canLaunch}
                className="btn btn-primary mt-4 inline-flex items-center gap-2 text-sm disabled:opacity-50"
              >
                {jobStatus.launching ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
                {spatialMode
                  ? 'Run spatial Seurat preprocessing'
                  : multiSampleMode ? 'Prepare multi-condition analysis' : 'Run Seurat preprocessing'}
              </button>
              </div>
            </div>
          </div>

          <div role="tabpanel" id={`${approachId}-guided-panel`} aria-labelledby={`${approachId}-guided-tab`}
            hidden={analysisApproach !== 'guided'} className="space-y-4">
            <p className="max-w-3xl text-sm leading-relaxed text-textMuted">Run and review one step at a time. Use each result to choose the settings for the next step.</p>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-border bg-background/40 px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs text-textMuted">Analysis to inspect</p>
                <p className="mt-1 break-words font-semibold text-text">{selectedObject?.displayName || selectedObject?.name || 'No dataset selected'}</p>
                {!guidedReady && <p className="mt-1 text-sm text-textMuted">Open an analysis in the workspace to start inspecting its steps.</p>}
              </div>
              <button type="button" onClick={() => setActiveTab?.('workspace')} className="btn btn-secondary text-sm">
                {guidedReady ? 'Change analysis' : 'Choose / open analysis'}
              </button>
            </div>
            <ol className="divide-y divide-border rounded border border-border bg-background/40">
              {[
                ['inspect', 'Inspect', 'Check the input data and metadata.'],
                ['qc', 'Quality control', 'Review distributions and choose cell filters.'],
                ['normalize', 'Normalization', 'Choose a method and variable features.'],
                ['integrate', 'Integration (optional)', 'Combine samples when integration is needed.'],
                ['pca', 'PCA', 'Review principal components before choosing dimensions.'],
                ['cluster', 'Clustering', 'Compare groups and adjust resolution.'],
                ['umap', 'UMAP', 'Review the cell embedding.'],
              ].map(([route, title, description], index) => (
                <li key={route} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="flex min-w-0 flex-1 items-baseline gap-3">
                    <span className="pipeline-step-number" aria-hidden="true">{index + 1}.</span>
                    <div><h4 className="font-semibold text-text">{title}</h4><p className="mt-1 text-xs leading-relaxed text-textMuted">{description}</p></div>
                  </div>
                  <button type="button" onClick={() => openGuidedStep(route)} disabled={!guidedReady}
                    className="btn btn-secondary text-sm" aria-label={`Open ${title}`}>Open</button>
                </li>
              ))}
            </ol>
          </div>

          {hasRunActivity && <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="Pipeline run">
            <div className="rounded border border-border bg-background/40 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="font-bold text-text">Run status</h4>
                {job?.id && (
                  <button onClick={() => refreshJob(job.id)} disabled={jobStatus.refreshing} className="btn btn-secondary inline-flex items-center gap-2 px-3 py-1.5 text-xs">
                    {jobStatus.refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    Refresh run
                  </button>
                )}
              </div>
              {jobStatus.error && <div className="mb-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{safeMessage(jobStatus.error)}</div>}
              {!job ? (
                <p className="text-sm text-textMuted">No {spatialMode ? 'spatial Seurat' : multiSampleMode ? 'multi-condition Seurat' : 'Seurat'} preprocessing run has been launched from this panel yet.</p>
              ) : (
                <div className="space-y-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-text">{spatialMode ? 'Spatial Seurat preprocessing' : multiSampleMode ? 'Multi-condition Seurat preparation' : 'Seurat preprocessing'}</span>
                    <StatusPill label={displayRunStatus(job.status)} tone={job.status === 'completed' ? 'green' : job.status === 'failed' ? 'amber' : 'blue'} />
                  </div>
                  <div className="text-xs text-textMuted">Created: {formatDate(job.createdAt)}</div>
                  <div className="grid grid-cols-1 gap-2 text-xs">
                    <div>{multiSampleMode ? 'Primary dataset' : 'Dataset'}: <span className="text-text">{activeDataset?.originalFilename || activeDataset?.displayName || 'Selected dataset'}</span></div>
                    <div>Input analysis: <span className="text-text">{inputObject?.displayName || inputObject?.name || selectedObject?.displayName || selectedObject?.name || 'Selected analysis'}</span></div>
                    <div>Result: <span className="text-text">{resultObject?.displayName || resultObject?.name || (resultObjectId ? 'Dataset is ready' : 'Preparing dataset')}</span></div>
                  </div>
                  {job.error?.message && (
                    <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-danger">
                      {safeMessage(job.error.message)}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="rounded border border-border bg-background/40 p-4">
              <h4 className="mb-3 flex items-center gap-2 font-bold text-text">Continue this analysis</h4>
              {safeSummary ? (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {Object.entries(safeSummary).slice(0, 6).map(([key, value]) => (
                    <div key={key} className="rounded border border-border bg-surface p-2">
                      <div className="font-medium text-textMuted">{key}</div>
                      <div className="mt-1 truncate text-text">{Array.isArray(value) ? value.join(', ') : String(value)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-textMuted">A summary will appear here when the analysis run finishes.</p>
              )}
              <div className="mt-3 space-y-2 text-xs text-textMuted">
                <p>Result: <span className="text-text">{resultObject?.displayName || resultObject?.name || (resultObjectId ? 'Dataset is ready' : 'Not available yet')}</span></p>
                <p>Saved version: <span className="text-text">{checkpointArtifact ? 'Available' : 'Not available yet'}</span></p>
                {resultObjectId && resultObject?.liveState !== 'attached' && (
                  <p>Open this saved version in your private analysis workspace before continuing with downstream analysis.</p>
                )}
                {multiSampleMode && resultObjectId && (
                  <p>Before condition-level inference, confirm the biological samples, conditions, and object bindings in Study Design.</p>
                )}
                {loadJob?.id && (
                  <p>Open saved version: <span className="text-text">{displayRunStatus(loadJob.status)}</span></p>
                )}
              </div>
              {(loadStatus.error || loadJobErrorMessage) && (
                <div className="mt-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                  {safeMessage(loadStatus.error || loadJobErrorMessage)}
                </div>
              )}
              {warnings.length > 0 && (
                <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                  {warnings.map((warning, index) => <div key={`${warning}-${index}`}>{safeMessage(warning)}</div>)}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={loadCheckpoint}
                  disabled={!resultObjectId || loadStatus.launching || loadStatus.refreshing || loadCompleted}
                  className="btn btn-secondary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                >
                  {loadStatus.launching || loadStatus.refreshing ? <Loader2 size={16} className="animate-spin" /> : <Archive size={16} />}
                  {loadCompleted ? 'Saved version opened' : 'Open saved version'}
                </button>
                {loadJob?.id && loadJob.status !== 'completed' && (
                  <button
                    onClick={() => refreshLoadJob(loadJob.id)}
                    disabled={loadStatus.refreshing}
                    className="btn btn-secondary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                  >
                    {loadStatus.refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                    Refresh
                  </button>
                )}
                <button
                  onClick={inspectPipelineResult}
                  disabled={!canContinueToDeg}
                  className="btn btn-secondary text-sm disabled:opacity-50"
                >Inspect this result step by step</button>
                <button
                  onClick={continueToDeg}
                  disabled={!canContinueToDeg}
                  className="btn btn-primary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                >
                  Continue to marker analysis
                </button>
                {multiSampleMode && (
                  <button
                    onClick={continueToStudyDesign}
                    disabled={!canContinueToDeg}
                    className="btn btn-secondary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                  >
                    Continue to Study Design
                  </button>
                )}
                <button onClick={() => setActiveTab('history')} className="btn btn-secondary text-sm">
                  Open Runs & Results
                </button>
              </div>
            </div>

            <details className="rounded border border-border bg-background/40 p-4 lg:col-span-2">
              <summary className="cursor-pointer font-semibold text-textMuted hover:text-text">Run notes</summary>
              {logs.length === 0 ? (
                <p className="text-sm text-textMuted">Run notes will appear when compute begins.</p>
              ) : (
                <div className="mt-3 max-h-44 space-y-2 overflow-y-auto custom-scrollbar">
                  {logs.map((entry, index) => (
                    <div key={`${entry?.ts || index}-${index}`} className="rounded border border-border bg-surface p-2 text-xs">
                      <div className="font-mono text-textMuted">{formatDate(entry?.ts)} / {entry?.level || 'info'}</div>
                      <div className="mt-1 text-textMuted">{researcherRunNote(entry)}</div>
                    </div>
                  ))}
                </div>
              )}
            </details>
          </div>}
        </div>
      )}
    </section>
  );
}
