import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  FileText,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useTabParams } from '../hooks/useTabParams';
import { hasAttachedLiveRObject } from '../liveRState';
import { publicErrorMessage } from '../publicError';
import PageHeader from '../components/PageHeader';
import useProjectAnalysisJob from '../hooks/useProjectAnalysisJob';
import { EmptyNotice, JobLogs, Metric, StatusBadge, displayRunStatus, formatDate, runStatusTone } from '../components/analysisRunDisplay';

const CELLCHAT_JOB_TYPE = 'cellchat.infer.v1';
const JOB_WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);
const MAX_VISIBLE_GROUPS = 50;
const MAX_VISIBLE_ROWS = 100;
const OPAQUE_GROUP_RE = /^Group ([1-9]\d*)$/;

const GROUP_BY_OPTIONS = [
  ['seurat_clusters', 'Seurat clusters'],
  ['ident', 'Current identities'],
];
const SPECIES_OPTIONS = [
  ['human', 'Human'],
  ['mouse', 'Mouse'],
];
const DATABASE_CATEGORY_OPTIONS = [
  ['all', 'All CellChatDB categories'],
  ['secreted_signaling', 'Secreted signaling'],
  ['ecm_receptor', 'ECM–receptor'],
  ['cell_cell_contact', 'Cell–cell contact'],
];
const ANALYSIS_INTENT_OPTIONS = [
  ['single_context', 'One biological context only'],
];

const DEFAULT_PARAMS = {
  groupBy: '',
  assay: 'RNA',
  species: '',
  databaseCategory: '',
  analysisIntent: '',
  minCellsPerGroup: 10,
  maxCellsPerGroup: 5000,
  maxTotalCells: 10000,
  pValueCutoff: 0.05,
  topInteractions: 25,
  topPathways: 15,
  randomSeed: 1,
};

function allowedValue(value, options, fallback = '') {
  return options.some(([candidate]) => candidate === value) ? value : fallback;
}

function clampNumber(value, min, max, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampInteger(value, min, max, fallback) {
  return Math.trunc(clampNumber(value, min, max, fallback));
}

function buildCellChatParams(params) {
  const minCellsPerGroup = clampInteger(params.minCellsPerGroup, 5, 200, 10);
  const maxCellsPerGroup = Math.max(
    minCellsPerGroup,
    clampInteger(params.maxCellsPerGroup, 100, 10000, 5000)
  );
  const maxTotalCells = Math.max(
    minCellsPerGroup * 2,
    clampInteger(params.maxTotalCells, 1000, 10000, 10000)
  );
  return {
    groupBy: allowedValue(params.groupBy, GROUP_BY_OPTIONS),
    assay: 'RNA',
    species: allowedValue(params.species, SPECIES_OPTIONS),
    databaseCategory: allowedValue(params.databaseCategory, DATABASE_CATEGORY_OPTIONS),
    analysisIntent: allowedValue(params.analysisIntent, ANALYSIS_INTENT_OPTIONS),
    minCellsPerGroup,
    maxCellsPerGroup,
    maxTotalCells,
    pValueCutoff: clampNumber(params.pValueCutoff, 0.000001, 0.1, 0.05),
    topInteractions: clampInteger(params.topInteractions, 5, 100, 25),
    topPathways: clampInteger(params.topPathways, 5, 100, 15),
    randomSeed: clampInteger(params.randomSeed, 0, 2147483647, 1),
  };
}

function cellChatReasonMessage(code) {
  const messages = {
    CELLCHAT_PACKAGES_UNAVAILABLE: 'CellChat is unavailable in the current analysis runtime. Ask an operator to enable the required package profile.',
    CELLCHAT_GROUPING_UNAVAILABLE: 'CellChat needs valid clustering or identity labels. Run clustering or choose current identities and try again.',
    CELLCHAT_GROUP_COUNT_INVALID: 'CellChat needs between two and 32 populated groups. Review the selected grouping and try again.',
    CELLCHAT_MIN_GROUP_CELLS: 'At least two groups must meet the minimum cell threshold. Lower the threshold or revise the grouping.',
    CELLCHAT_ASSAY_UNAVAILABLE: 'CellChat requires an RNA assay in the dataset.',
    CELLCHAT_NORMALIZED_DATA_REQUIRED: 'CellChat requires normalized RNA data. Run normalization and try again.',
    CELLCHAT_DATABASE_OVERLAP_LOW: 'Too few signaling genes overlap the selected CellChat database. Check the species and RNA assay.',
    CELLCHAT_INPUT_INVALID: 'CellChat could not construct a valid input. Review the grouping, assay, species, and dataset.',
  };
  return messages[code] || null;
}

function redactUnsafeText(value) {
  return String(value || '')
    .replace(/[A-Za-z]:[\\/][^\s'")]+/g, '[redacted path]')
    .replace(/(?:^|\s)\/(?:[^\s'")]+\/){1,}[^\s'")]+/g, '[redacted path]')
    .replace(/\b(?:https?|file):\/\/[^\s'")]+/gi, '[redacted URL]')
    .replace(/\bvault\/[^\s'")]+/gi, '[redacted storage]')
    .replace(/\b(?:storage_?(?:uri|key)|claim_?token|state_?key)\b/gi, '[redacted field]')
    .replace(/\buser-\d+:obj-[A-Za-z0-9_-]+/g, '[redacted state]');
}

function safeText(value, maxLength = 160) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/(?:[A-Za-z]:[\\/]|(?:https?|file):\/\/|\bvault\/|\bstorage_?(?:uri|key)\b|\bstate_?key\b)/i.test(text)) {
    return null;
  }
  return redactUnsafeText(text).slice(0, maxLength);
}

function safeCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function safeStat(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Raw labels belong exclusively in the owner-local mapping. Public summary
// artifacts can render only the fixed opaque identifiers produced by Node/R.
function opaqueGroup(value) {
  const group = safeText(value, 80);
  const match = group && OPAQUE_GROUP_RE.exec(group);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index <= 32 ? `Group ${index}` : null;
}

function summaryGroup(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const name = opaqueGroup(row.group);
  if (!name) return null;
  const safe = { name };
  const inputCells = safeCount(
    row.inputCells ?? row.input_cells ?? row.cellCount ?? row.cell_count ?? row.count ?? row.cells,
  );
  const analyzedCells = safeCount(row.analyzedCells ?? row.analyzed_cells);
  if (inputCells !== null) safe.inputCells = inputCells;
  if (analyzedCells !== null) safe.analyzedCells = analyzedCells;
  const reason = safeText(row.reason, 160);
  if (reason) safe.reason = reason;
  return { ...safe, key: `${name}-${index}` };
}

function summaryInteraction(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const source = opaqueGroup(row.source);
  const target = opaqueGroup(row.target);
  const ligand = safeText(row.ligand, 80);
  const receptor = safeText(row.receptor, 80);
  const interaction = safeText(row.interaction ?? row.ligandReceptor, 120)
    || (ligand && receptor ? `${ligand}–${receptor}` : null);
  if (!source || !target || !interaction) return null;
  const safe = { source, target, interaction, key: `${source}-${target}-${interaction}-${index}` };
  const pathway = safeText(row.pathway ?? row.signalingPathway, 80);
  const probability = safeStat(row.probability ?? row.communicationProbability ?? row.score);
  const pValue = safeStat(row.pValue ?? row.p_value);
  if (pathway) safe.pathway = pathway;
  if (probability !== null) safe.probability = probability;
  if (pValue !== null && pValue >= 0 && pValue <= 1) safe.pValue = pValue;
  return safe;
}

function summaryPathway(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const name = safeText(row.name ?? row.pathway ?? row.signalingPathway, 120);
  if (!name) return null;
  const safe = { name, key: `${name}-${index}` };
  const source = opaqueGroup(row.source);
  const target = opaqueGroup(row.target);
  const probability = safeStat(row.probability ?? row.communicationProbability ?? row.score);
  const pValue = safeStat(row.pValue ?? row.p_value);
  if (!source || !target) return null;
  if (source) safe.source = source;
  if (target) safe.target = target;
  if (probability !== null) safe.probability = probability;
  if (pValue !== null && pValue >= 0 && pValue <= 1) safe.pValue = pValue;
  return safe;
}

function sanitizePackageVersions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw)
    .filter(([name]) => /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(name))
    .map(([name, value]) => ({ name, value: safeText(value, 64) }))
    .filter(entry => entry.value)
    .slice(0, 8);
}

function sanitizeSummary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const summary = {
    groupBy: allowedValue(raw.groupBy, GROUP_BY_OPTIONS),
    assay: raw.assay === 'RNA' ? 'RNA' : '',
    species: allowedValue(raw.species, SPECIES_OPTIONS),
    databaseCategory: allowedValue(raw.databaseCategory, DATABASE_CATEGORY_OPTIONS),
    analysisIntent: allowedValue(raw.analysisIntent, ANALYSIS_INTENT_OPTIONS),
    groups: Array.isArray(raw.groups)
      ? raw.groups.map(summaryGroup).filter(Boolean).slice(0, MAX_VISIBLE_GROUPS)
      : [],
    excludedGroups: Array.isArray(raw.excludedGroups)
      ? raw.excludedGroups.map(summaryGroup).filter(Boolean).slice(0, MAX_VISIBLE_GROUPS)
      : [],
    topInteractions: Array.isArray(raw.topInteractions)
      ? raw.topInteractions.map(summaryInteraction).filter(Boolean).slice(0, MAX_VISIBLE_ROWS)
      : [],
    topPathways: Array.isArray(raw.topPathways)
      ? raw.topPathways.map(summaryPathway).filter(Boolean).slice(0, MAX_VISIBLE_ROWS)
      : [],
    packageVersions: sanitizePackageVersions(raw.packageVersions),
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.map(value => safeText(value, 240)).filter(Boolean).slice(0, 32)
      : [],
  };
  for (const name of [
    'inputCellCount', 'analyzedCellCount', 'inputGroupCount', 'analyzedGroupCount',
    'excludedGroupCount', 'candidateInteractionCount', 'retainedInteractionCount',
    'retainedPathwayCount',
  ]) {
    const value = safeCount(raw[name]);
    if (value !== null) summary[name] = value;
  }
  return summary;
}

// Raw group labels are intentionally absent from the project-visible artifact.
// This short-lived key is fetched only from the job owner's attached live R
// object and is kept in component memory; it is never persisted to a job,
// artifact, log, or tab parameter cache.
function sanitizeOwnerGroupKey(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const groupBy = allowedValue(raw.group_by ?? raw.groupBy, GROUP_BY_OPTIONS);
  if (!groupBy || !Array.isArray(raw.groups)) return null;
  const groups = [];
  for (const row of raw.groups) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const group = opaqueGroup(row.group);
    const label = safeText(row.label, 160);
    const inputCells = safeCount(row.input_cells ?? row.inputCells);
    if (group && label && inputCells !== null) {
      groups.push({ group, label, inputCells });
    }
    if (groups.length >= 32) break;
  }
  return { groupBy, groups };
}

function formatNumber(value, digits = 3) {
  if (value === null || value === undefined || value === '') return 'NA';
  const number = Number(value);
  if (!Number.isFinite(number)) return 'NA';
  if (number !== 0 && Math.abs(number) < 0.001) return number.toExponential(2);
  return Number.isInteger(number) ? String(number) : number.toFixed(digits);
}

function formatCategory(value) {
  return DATABASE_CATEGORY_OPTIONS.find(([candidate]) => candidate === value)?.[1] || 'Not recorded';
}

function formatGroupBy(value) {
  return GROUP_BY_OPTIONS.find(([candidate]) => candidate === value)?.[1] || 'Not recorded';
}

function InteractionTable({ interactions }) {
  if (!interactions.length) {
    return <EmptyNotice title="No retained interactions in the safe preview">The private result table may contain no retained candidates for the configured thresholds.</EmptyNotice>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[760px] text-left text-xs">
        <thead className="bg-background text-xs font-medium text-textMuted">
          <tr>
            <th className="p-3">Source group</th>
            <th className="p-3">Target group</th>
            <th className="p-3">Ligand–receptor candidate</th>
            <th className="p-3">Pathway</th>
            <th className="p-3">Probability</th>
            <th className="p-3">p-value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40 bg-surface/70">
          {interactions.map(row => (
            <tr key={row.key}>
              <td className="p-3 font-bold text-text">{row.source}</td>
              <td className="p-3 font-bold text-text">{row.target}</td>
              <td className="p-3 text-textMuted">{row.interaction}</td>
              <td className="p-3 text-textMuted">{row.pathway || 'NA'}</td>
              <td className="p-3 font-mono text-textMuted">{formatNumber(row.probability)}</td>
              <td className="p-3 font-mono text-textMuted">{formatNumber(row.pValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PathwayTable({ pathways }) {
  if (!pathways.length) {
    return <EmptyNotice title="No pathway preview returned">No pathway-level candidate rows were retained in the bounded public summary.</EmptyNotice>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[680px] text-left text-xs">
        <thead className="bg-background text-xs font-medium text-textMuted">
          <tr>
            <th className="p-3">Signaling pathway</th>
            <th className="p-3">Source group</th>
            <th className="p-3">Target group</th>
            <th className="p-3">Probability</th>
            <th className="p-3">p-value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40 bg-surface/70">
          {pathways.map(row => (
            <tr key={row.key}>
              <td className="p-3 font-bold text-text">{row.name}</td>
              <td className="p-3 text-textMuted">{row.source || 'NA'}</td>
              <td className="p-3 text-textMuted">{row.target || 'NA'}</td>
              <td className="p-3 font-mono text-textMuted">{formatNumber(row.probability)}</td>
              <td className="p-3 font-mono text-textMuted">{formatNumber(row.pValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupList({ groups, title, emptyText, showReason = false }) {
  if (!groups.length) return <p className="text-sm text-textMuted">{emptyText}</p>;
  return (
    <div>
      <h4 className="mb-2 text-sm font-bold text-text">{title}</h4>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map(group => (
          <li key={group.key} className="rounded border border-border bg-surface/60 px-3 py-2 text-xs">
            <div className="font-bold text-text">{group.name}</div>
            {group.inputCells !== undefined && <div className="mt-1 font-mono text-textMuted">{formatNumber(group.inputCells, 0)} input cells</div>}
            {group.analyzedCells !== undefined && <div className="mt-1 font-mono text-textMuted">{formatNumber(group.analyzedCells, 0)} analyzed cells</div>}
            {showReason && group.reason && <div className="mt-1 text-textMuted">{group.reason}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function CellChat({
  callApi,
  datasetInfo,
  currentWs,
  userEmail,
  userId,
  objectId,
  sessionReady,
  setActiveTab,
  computeStatus,
  unsavedLiveChanges = false,
  onSaveCurrentAnalysis,
  checkpointSaveBusy = false,
}) {
  const [params, setParam] = useTabParams('cellchat', userEmail, objectId, DEFAULT_PARAMS);
  const [ownerGroupKey, setOwnerGroupKey] = useState(null);
  const [ownerGroupKeyUnavailable, setOwnerGroupKeyUnavailable] = useState(false);

  const activeProjectId = datasetInfo?.projectId || currentWs?.selectedProjectId || currentWs?.projects?.[0]?.id || null;
  const selectedObjectId = objectId || datasetInfo?.id || currentWs?.selectedObjectIds?.[0] || null;
  const {
    job, logs, artifacts, loading, refreshing, canceling, error, setError, lastRefreshedAt,
    terminal, refreshJobState, submitJob, cancelJob: cancelActiveJob,
  } = useProjectAnalysisJob({ jobType: CELLCHAT_JOB_TYPE, activeProjectId, selectedObjectId });
  const activeProject = (currentWs?.projects || []).find(project => project.id === activeProjectId) || null;
  const selectedAnalysis = (currentWs?.objects || []).find(object => object.id === selectedObjectId)
    || datasetInfo
    || null;
  const selectedAnalysisName = selectedAnalysis?.displayName || selectedAnalysis?.name || 'Selected analysis';
  const isDbBackedObject = typeof selectedObjectId === 'string' && /^ao_[0-9a-f]+$/i.test(selectedObjectId);
  const liveObjectAttached = hasAttachedLiveRObject(datasetInfo);
  const canWriteProject = JOB_WRITE_ROLES.has(activeProject?.role);
  const ownsPrivateLiveObject = !datasetInfo?.ownerUserId
    || Number(datasetInfo.ownerUserId) === Number(userId);
  const computeReady = !computeStatus?.status || computeStatus.status === 'ready';
  // The API limits analysts to their own jobs; without a projected per-job
  // capability we only expose cancellation to project-wide privileged roles.
  const canCancelJob = activeProject?.role === 'owner' || activeProject?.role === 'admin';
  const safeParams = useMemo(() => buildCellChatParams(params), [params]);
  const canLaunch = Boolean(
    userEmail
      && activeProjectId
      && isDbBackedObject
      && canWriteProject
      && sessionReady
      && liveObjectAttached
      && ownsPrivateLiveObject
      && !unsavedLiveChanges
      && safeParams.groupBy
      && safeParams.species
      && safeParams.databaseCategory
      && safeParams.analysisIntent
      && !loading
  );
  const summaryArtifact = artifacts.find(artifact => artifact.artifactType === 'cellchat_summary') || null;
  const resultsArtifact = artifacts.find(artifact => artifact.artifactType === 'cellchat_results') || null;
  const summary = useMemo(
    () => sanitizeSummary(summaryArtifact?.metadata?.summary),
    [summaryArtifact]
  );
  const visibleLogs = logs.length ? logs : (Array.isArray(job?.logs) ? job.logs : []);
  const resolvedParams = {
    ...safeParams,
    ...(job?.parameters && typeof job.parameters === 'object' ? job.parameters : {}),
    ...(summaryArtifact?.metadata?.resolvedParams && typeof summaryArtifact.metadata.resolvedParams === 'object'
      ? summaryArtifact.metadata.resolvedParams
      : {}),
  };
  const groupKeyGroupBy = summary?.groupBy || resolvedParams.groupBy || '';

  useEffect(() => {
    let canceled = false;
    setOwnerGroupKey(null);
    setOwnerGroupKeyUnavailable(false);
    if (!summary || !job?.id || !groupKeyGroupBy || !liveObjectAttached || typeof callApi !== 'function') {
      return () => { canceled = true; };
    }

    const loadOwnerGroupKey = async () => {
      try {
        const response = await callApi(
          `/cellchat-group-map?group_by=${encodeURIComponent(groupKeyGroupBy)}`,
          {},
          { useCache: false }
        );
        const safeKey = response?.error ? null : sanitizeOwnerGroupKey(response);
        if (!canceled) {
          setOwnerGroupKey(safeKey);
          setOwnerGroupKeyUnavailable(!safeKey || safeKey.groups.length === 0);
        }
      } catch {
        if (!canceled) setOwnerGroupKeyUnavailable(true);
      }
    };
    loadOwnerGroupKey();
    return () => { canceled = true; };
  }, [callApi, groupKeyGroupBy, job?.id, liveObjectAttached, summary]);

  const launchJob = useCallback(async () => {
    setError(null);
    if (!userEmail) return setError('Sign in before starting CellChat inference.');
    if (!activeProjectId) return setError('Select a project before starting CellChat inference.');
    if (!selectedObjectId || !isDbBackedObject) {
      return setError('Select a dataset before starting CellChat inference.');
    }
    if (!canWriteProject) return setError('Your project role can view results but cannot start analysis jobs.');
    if (!ownsPrivateLiveObject) {
      return setError('This analysis belongs to another member. Create a branch from its saved version in your private analysis workspace before starting CellChat inference.');
    }
    if (!sessionReady || !liveObjectAttached) {
      return setError('Open this dataset in your private analysis workspace before starting CellChat inference.');
    }
    if (unsavedLiveChanges) {
      return setError('Save the current analysis before starting this durable run. Unsaved clustering or other live steps are not included.');
    }
    if (!safeParams.groupBy || !safeParams.species || !safeParams.databaseCategory || !safeParams.analysisIntent) {
      return setError('Choose a grouping, species, CellChat database category, and the single-context analysis intent.');
    }

    const api = window.electronAPI || {};
    if (!api.createCellChatInferenceJob) {
      return setError('CellChat analysis is temporarily unavailable.');
    }
    if (typeof callApi !== 'function') {
      return setError('CellChat validation is temporarily unavailable.');
    }

    await submitJob(async () => {
      const preflight = await callApi(
        `/cellchat-group-map?group_by=${encodeURIComponent(safeParams.groupBy)}&preflight=true&min_cells_per_group=${encodeURIComponent(safeParams.minCellsPerGroup)}`,
        {},
        { useCache: false }
      );
      if (preflight?.ready !== true) {
        throw Object.assign(new Error(cellChatReasonMessage(preflight?.code) || 'CellChat could not validate this dataset.'), {
          code: preflight?.code,
        });
      }
      const created = await api.createCellChatInferenceJob(activeProjectId, selectedObjectId, safeParams);
      return created;
    });
    return undefined;
  }, [
    activeProjectId,
    callApi,
    canWriteProject,
    isDbBackedObject,
    liveObjectAttached,
    ownsPrivateLiveObject,
    safeParams,
    selectedObjectId,
    setError,
    submitJob,
    sessionReady,
    unsavedLiveChanges,
    userEmail,
  ]);

  const cancelJob = useCallback(async () => {
    if (canCancelJob) await cancelActiveJob();
  }, [canCancelJob, cancelActiveJob]);

  if (!datasetInfo) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-8 text-center">
        <div className="max-w-sm">
          <FileText size={48} className="mx-auto mb-4 text-slate-400 opacity-50" />
          <h2 className="mb-2 text-xl font-bold text-text">No dataset selected</h2>
          <p className="text-sm text-textMuted">Select a saved, clustered analysis before running CellChat inference.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-background p-4 sm:p-6 custom-scrollbar">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <PageHeader title="CellChat communication candidates" icon={MessageSquare} description={<>
          Find candidate signaling between cell groups using CellChat&apos;s ligand–receptor database.
        </>} actions={<>

            <button onClick={launchJob} disabled={!canLaunch} className="btn btn-primary inline-flex items-center gap-2 text-sm disabled:opacity-50">
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              Start CellChat Inference
            </button>
            {job?.id && (
              <button onClick={() => refreshJobState(job.id)} disabled={refreshing} className="btn btn-secondary inline-flex items-center gap-2 text-sm">
                {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                Refresh
              </button>
            )}

        </>} />

        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-3 rounded-lg border border-border bg-surface/50 px-4 py-3 text-sm">
          <div className="min-w-0"><dt className="text-xs text-textMuted">Project</dt><dd className="break-words font-medium text-text">{activeProject?.name || 'Selected project'}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-textMuted">Dataset</dt><dd className="break-words text-text">{selectedObjectId ? selectedAnalysisName : 'None selected'}</dd></div>
          <div className="min-w-0 col-span-2 sm:col-span-1"><dt className="text-xs text-textMuted">Assay</dt><dd className="text-text">RNA</dd></div>
        </dl>
        {isDbBackedObject && ownsPrivateLiveObject && !unsavedLiveChanges && <p className="text-sm text-textMuted">Runs use the saved checkpoint; live changes must be saved first.</p>}

        {isDbBackedObject && ownsPrivateLiveObject && unsavedLiveChanges && (
          <div className={`rounded-lg border p-4 text-sm ${unsavedLiveChanges ? 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200' : 'border-primary/20 bg-primary/5 text-textMuted'}`}>
            <p><span className="font-bold text-text">Saved checkpoint used by this run:</span> {selectedAnalysisName}</p>
            {unsavedLiveChanges && (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <p>Unsaved live steps will not be included. Save the current analysis before launching.</p>
                {typeof onSaveCurrentAnalysis === 'function' && <button type="button" className="btn btn-secondary text-xs" onClick={onSaveCurrentAnalysis} disabled={checkpointSaveBusy}>{checkpointSaveBusy ? 'Saving…' : 'Save current analysis'}</button>}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-danger" role="alert">
            <div className="flex items-center gap-2 font-bold"><AlertTriangle size={18} /> CellChat analysis unavailable</div>
            <p className="mt-1 text-sm">{publicErrorMessage(error, 'This analysis needs attention. Review the settings and try again.')}</p>
          </div>
        )}

        {!isDbBackedObject && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            Select a dataset before starting this analysis.
          </div>
        )}

        {isDbBackedObject && !canWriteProject && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            Your project role is read-only. You can inspect saved CellChat summaries, but only an owner, administrator, or analyst can start a new analysis.
          </div>
        )}

        {isDbBackedObject && canWriteProject && !ownsPrivateLiveObject && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            This analysis belongs to another member. Use Runs &amp; Results to create a branch from its saved version in your own private analysis workspace.
            <button onClick={() => setActiveTab?.('history')} className="btn btn-secondary ml-3 text-xs">Open Runs &amp; Results</button>
          </div>
        )}

        {isDbBackedObject && canWriteProject && ownsPrivateLiveObject && (!sessionReady || !liveObjectAttached) && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            This dataset is not open in your private analysis workspace yet. {datasetInfo?.source === 'pbmc3k_demo' && datasetInfo?.metadata?.curatedDemo !== true ? 'Return to the workspace to reload the built-in PBMC demo.' : 'Open Runs & Results to open its saved version.'}
            <button onClick={() => setActiveTab?.(datasetInfo?.source === 'pbmc3k_demo' && datasetInfo?.metadata?.curatedDemo !== true ? 'workspace' : 'history')} className="btn btn-secondary ml-3 text-xs">
              {datasetInfo?.source === 'pbmc3k_demo' && datasetInfo?.metadata?.curatedDemo !== true ? 'Open workspace' : 'Open Runs & Results'}
            </button>
          </div>
        )}

        {isDbBackedObject && canWriteProject && sessionReady && liveObjectAttached && ownsPrivateLiveObject && !computeReady && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            Compute is temporarily unavailable. You can submit this analysis now; it will wait in the durable queue until compute is available.
          </div>
        )}

        <section className="rounded-lg border border-border bg-surface/50 p-5">
          <h3 className="text-lg font-bold text-text">New run settings</h3>
          <p className="mt-1 max-w-4xl text-sm text-textMuted">
            Select every biological choice deliberately. This workflow is limited to one biological context; it does not perform a treated-versus-control or other between-condition comparison.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-textMuted">Group labels (required)</span>
              <select value={params.groupBy} onChange={event => setParam('groupBy', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text">
                <option value="">Choose grouping</option>
                {GROUP_BY_OPTIONS.map(([value, label]) => <option value={value} key={value} title={label}>{label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-textMuted">Assay</span>
              <input value="RNA" readOnly aria-label="Assay" className="w-full cursor-not-allowed rounded border border-border bg-surface/70 p-2.5 text-sm text-textMuted" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-textMuted">Species (required)</span>
              <select value={params.species} onChange={event => setParam('species', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text">
                <option value="">Choose species</option>
                {SPECIES_OPTIONS.map(([value, label]) => <option value={value} key={value} title={label}>{label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-textMuted">Database category (required)</span>
              <select value={params.databaseCategory} onChange={event => setParam('databaseCategory', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text">
                <option value="">Choose database category</option>
                {DATABASE_CATEGORY_OPTIONS.map(([value, label]) => <option value={value} key={value} title={label}>{label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-textMuted">Analysis intent (required)</span>
              <select value={params.analysisIntent} onChange={event => setParam('analysisIntent', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text">
                <option value="">Confirm analysis scope</option>
                {ANALYSIS_INTENT_OPTIONS.map(([value, label]) => <option value={value} key={value} title={label}>{label}</option>)}
              </select>
            </label>
          </div>
          <details className="mt-4 rounded-lg border border-border bg-background/30 p-4">
            <summary className="cursor-pointer text-sm font-bold text-text">Advanced options</summary>
            <p className="mt-2 text-xs text-textMuted">Sampling bounds, display limits, statistical cutoff, and reproducibility seed.</p>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-textMuted">Minimum cells per group</span>
              <input type="number" min="5" max="200" value={params.minCellsPerGroup} onChange={event => setParam('minCellsPerGroup', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-textMuted">Maximum cells per group</span>
              <input type="number" min="100" max="10000" value={params.maxCellsPerGroup} onChange={event => setParam('maxCellsPerGroup', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-textMuted">Maximum cells total</span>
              <input type="number" min="1000" max="10000" value={params.maxTotalCells} onChange={event => setParam('maxTotalCells', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-textMuted">p-value cutoff</span>
              <input type="number" min="0.000001" max="0.1" step="0.01" value={params.pValueCutoff} onChange={event => setParam('pValueCutoff', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-textMuted">Interactions shown</span>
              <input type="number" min="5" max="100" value={params.topInteractions} onChange={event => setParam('topInteractions', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-textMuted">Pathways shown</span>
              <input type="number" min="5" max="100" value={params.topPathways} onChange={event => setParam('topPathways', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-textMuted">Random seed</span>
              <input type="number" min="0" max="2147483647" value={params.randomSeed} onChange={event => setParam('randomSeed', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            </div>
            <p className="mt-3 text-xs text-textMuted">Runs include up to 10,000 cells. The random seed makes sampling repeatable.</p>
          </details>
        </section>

        <section className="rounded-lg border border-border bg-surface/50 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-bold text-text">Run status</h3>
              <p className="mt-1 text-sm text-textMuted">Compute is allocated when available. When demand is high, a new analysis waits for compute.</p>
            </div>
            <div className="flex items-center gap-2">
              {job?.status && <StatusBadge tone={runStatusTone(job.status)}>{displayRunStatus(job.status)}</StatusBadge>}
              {job?.id && !terminal && canCancelJob && (
                <button
                  onClick={cancelJob}
                  disabled={canceling}
                  className="btn btn-secondary inline-flex items-center gap-1.5 text-xs disabled:opacity-50"
                >
                  {canceling ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
                  Cancel run
                </button>
              )}
            </div>
          </div>
          {!job ? (
            <EmptyNotice title="No CellChat analysis run yet">Choose the required study choices above, then start CellChat inference.</EmptyNotice>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
                <div><div className="text-xs font-medium text-textMuted">Outcome</div><div className="mt-1 text-text">{displayRunStatus(job.status)}</div></div>
                <div><div className="text-xs font-medium text-textMuted">Last refreshed</div><div className="mt-1 text-text">{formatDate(lastRefreshedAt)}</div></div>
              </div>
              {job.error?.message && <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{publicErrorMessage(job.error, 'This analysis needs attention. Review the settings and try again.')}</div>}
              <JobLogs logs={visibleLogs} />
            </div>
          )}
        </section>

        <section className="rounded-lg border border-border bg-surface/50 p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-bold text-text">CellChat summary</h3>
              <p className="mt-1 text-sm text-textMuted">This page shows a bounded candidate summary for interpretation. The complete interaction table is available through authorized export.</p>
            </div>
            {summaryArtifact && <StatusBadge tone="green">summary available</StatusBadge>}
          </div>

          {summary ? (
            <div className="space-y-6">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Metric label="Cells analyzed" value={`${formatNumber(summary.analyzedCellCount, 0)} / ${formatNumber(summary.inputCellCount, 0)}`} detail="After bounded sampling" />
                <Metric label="Groups analyzed" value={`${formatNumber(summary.analyzedGroupCount, 0)} / ${formatNumber(summary.inputGroupCount, 0)}`} detail={`${formatNumber(summary.excludedGroupCount, 0)} excluded`} />
                <Metric label="Candidate interactions" value={formatNumber(summary.candidateInteractionCount, 0)} detail="Before retention cutoff" />
                <Metric label="Retained interactions" value={formatNumber(summary.retainedInteractionCount, 0)} detail={`${formatNumber(summary.retainedPathwayCount, 0)} signaling pathways`} />
              </div>

              <h4 className="text-sm font-bold text-text">Recorded run settings</h4>
              <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded border border-border bg-surface/60 p-3"><div className="text-xs font-medium text-textMuted">Grouping</div><div className="mt-1 font-bold text-text">{formatGroupBy(summary.groupBy || resolvedParams.groupBy)}</div></div>
                <div className="rounded border border-border bg-surface/60 p-3"><div className="text-xs font-medium text-textMuted">Species / assay</div><div className="mt-1 font-bold text-text">{summary.species || resolvedParams.species || 'Not recorded'} / {summary.assay || resolvedParams.assay || 'RNA'}</div></div>
                <div className="rounded border border-border bg-surface/60 p-3"><div className="text-xs font-medium text-textMuted">Database category</div><div className="mt-1 font-bold text-text">{formatCategory(summary.databaseCategory || resolvedParams.databaseCategory)}</div></div>
                <div className="rounded border border-border bg-surface/60 p-3"><div className="text-xs font-medium text-textMuted">Analysis scope</div><div className="mt-1 font-bold text-text">{(summary.analysisIntent || resolvedParams.analysisIntent) === 'single_context' ? 'One biological context' : 'Not recorded'}</div></div>
              </div>

              {summary.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
                  <div className="mb-2 font-bold">Analysis notes</div>
                  <ul className="list-disc space-y-1 pl-5">
                    {summary.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
                  </ul>
                </div>
              )}

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <GroupList groups={summary.groups} title="Analyzed groups" emptyText="No group rows were included in the bounded summary." />
                <GroupList groups={summary.excludedGroups} title="Excluded groups" emptyText="No groups were excluded in the bounded summary." showReason />
              </div>

              <div className="rounded-lg border border-border bg-surface/60 p-4 text-sm">
                <h4 className="font-bold text-text">Group labels in this private analysis workspace</h4>
                <p className="mt-1 text-textMuted">
                  Group labels are available only while the owner&apos;s dataset is open in their private analysis workspace; they are not saved with the shared result. If identities changed after this analysis ran, rerun it before interpreting the mapping.
                </p>
                {ownerGroupKey?.groups?.length ? (
                  <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {ownerGroupKey.groups.map(row => (
                      <li key={row.group} className="rounded border border-border/70 bg-background/30 px-3 py-2 text-xs">
                        <span className="font-mono font-bold text-text">{row.group}</span>
                        <span className="mx-2 text-textMuted">→</span>
                        <span className="font-bold text-text">{row.label}</span>
                        <span className="ml-2 font-mono text-textMuted">({formatNumber(row.inputCells, 0)} input cells)</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-xs text-textMuted">
                    {ownerGroupKeyUnavailable
                      ? 'The group-label mapping is unavailable. Open the source dataset in your private analysis workspace to recover it.'
                      : 'Loading group labels from the attached private analysis workspace…'}
                  </p>
                )}
              </div>

              <p className="rounded border border-border bg-surface/40 p-3 text-xs text-textMuted">
                Communication probabilities use capped per-group expression and do not encode original population abundance. Compare candidates within this configured run; do not interpret probability as an abundance-weighted communication rate.
              </p>

              <div>
                <h4 className="mb-2 text-sm font-bold text-text">Top candidate interactions</h4>
                <p className="mb-3 text-xs text-textMuted">These are database-guided ligand–receptor predictions, not observations of direct physical contact or causal signaling.</p>
                <InteractionTable interactions={summary.topInteractions} />
              </div>

              <div>
                <h4 className="mb-2 text-sm font-bold text-text">Top candidate signaling pathways</h4>
                <PathwayTable pathways={summary.topPathways} />
              </div>

              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-textMuted">
                A saved summary is available. The full interaction table is available only through its authorized export.
              </div>
            </div>
          ) : job?.status === 'completed' ? (
            <EmptyNotice title="Analysis completed without a summary">Review the recorded analysis details. If a result completed, its authorized export is available in Runs &amp; Results.</EmptyNotice>
          ) : (
            <EmptyNotice title="No CellChat summary yet">A bounded summary appears here after the analysis finishes successfully.</EmptyNotice>
          )}

          {resultsArtifact && (
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
              A detailed result table is available through the authorized export in Runs &amp; Results.
            </div>
          )}
        </section>

        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-textMuted">
          <div className="mb-1 flex items-center gap-2 font-bold text-text"><ShieldCheck size={16} className="text-primary" /> How to interpret this result</div>
          CellChat produces candidate predictions from expression patterns and a curated ligand–receptor database. It does not prove that cells communicated, physically contacted, or caused a response. This v1 supports one biological context only; condition or patient comparisons require sample-aware study metadata and are not available here.
        </div>
      </div>
    </div>
  );
}
