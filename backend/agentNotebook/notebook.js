'use strict';

// The agent notebook: everything agents did in a project, as cells in the
// order it happened, each filed under the analysis tab it serves
// (shared/agentNotebookTabs.mjs).
//
// Four kinds of cell:
//   verified    a run of a reviewed workflow or library method through a study.
//               Its code is the reviewed release; the cell shows the release,
//               the study's objective and the agent's parameter choices.
//   agent_code  an agent's own R script from a sandbox, flagged as AI-written
//               code until a person promotes or discards it.
//   note        a short Markdown note the agent placed between its cells.
//   ledger      an analysis ledger entry (shared/analysisLedger.mjs): a
//               decision, cluster label, finding, issue or checklist answer
//               with the outputs it cites. They appear as the agent records
//               them, so the notebook shows its reasoning while it works.
//
// Cells are read-only records. Agents only ever append: a run or note, once
// written, is not edited or reordered (the tables are append-only).

const crypto = require('crypto');
const { READ_ROLES, MANAGE_ROLES, codedError } = require('../policy/agentCapabilities');
const { recordAutomationEvent } = require('../automation/automationAudit');
const {
  AGENT_NOTEBOOK_TABS, AGENT_NOTEBOOK_TAB_IDS, isAgentNotebookTab, agentNotebookTabLabel, tabForRelease,
} = require('../../shared/agentNotebookTabs.mjs');

const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_NOTE_CHARS = 8000;
const MAX_NOTES_PER_DELEGATION = 500;

function rejectUnknown(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw codedError('INVALID_INPUT', 'A JSON object is required.', 400);
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw codedError('UNKNOWN_FIELD', `Unknown field: ${key.slice(0, 64)}.`, 400);
  }
}

function requireHuman(actor) {
  if (actor?.kind !== 'human') throw codedError('HUMAN_ACTOR_REQUIRED', 'This operation requires a signed-in person.', 403);
}

function methodCategory(releaseKey) {
  try {
    return require('../workflowTrust/trustedMethods').methodByKey(releaseKey)?.category;
  } catch {
    return undefined;
  }
}

function releaseTitle(releaseKey) {
  try {
    return require('../workflowTrust/catalog').releaseByKey(releaseKey)?.title || releaseKey;
  } catch {
    return releaseKey;
  }
}

function time(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function iso(value) {
  const t = time(value);
  return t ? new Date(t).toISOString() : null;
}

function verifiedCell(run, objectives) {
  const tab = tabForRelease(run.release, { methodCategory: methodCategory(run.release?.key) });
  return {
    kind: 'verified',
    id: run.id,
    tab,
    tabLabel: agentNotebookTabLabel(tab),
    createdAt: iso(run.createdAt),
    agent: run.agent,
    authorship: 'verified',
    study: { id: run.studyId, name: run.studyName || null, objective: objectives.get(run.studyId) || '' },
    trialNumber: run.trialNumber,
    release: {
      id: run.release?.id, key: run.release?.key, version: run.release?.version,
      digest: run.release?.digest, title: releaseTitle(run.release?.key),
    },
    choices: run.choices || {},
    inputAnalysisObjectId: run.inputs?.analysisObjectId || null,
    resultAnalysisObjectId: run.resultAnalysisObjectId || null,
    resultArtifactId: run.resultArtifactId || null,
    state: run.state,
    acceptance: run.acceptance,
    summary: run.summary || null,
    failure: run.failure || null,
  };
}

function agentCodeCell(run) {
  const tab = isAgentNotebookTab(run.tab) ? run.tab : 'explore';
  return {
    kind: 'agent_code',
    id: run.id,
    tab,
    tabLabel: agentNotebookTabLabel(tab),
    // Runs submitted before agents named a tab are filed under Exploratory.
    tabAssigned: isAgentNotebookTab(run.tab),
    createdAt: iso(run.createdAt),
    agent: run.agent,
    authorship: 'ai_written',
    title: run.title,
    reason: run.reason,
    sandboxId: run.sandboxId,
    sandboxName: run.sandboxName,
    runNumber: run.runNumber,
    scriptSha256: run.scriptSha256,
    steps: run.steps || [],
    files: run.files || [],
    inputAnalysisObjectId: run.inputAnalysisObjectId || null,
    resultAnalysisObjectId: run.resultAnalysisObjectId || null,
    state: run.state,
    review: run.review,
    error: run.error || null,
  };
}

function noteCell(row) {
  return {
    kind: 'note',
    id: row.id,
    tab: row.analysis_tab,
    tabLabel: agentNotebookTabLabel(row.analysis_tab),
    createdAt: iso(row.created_at),
    agent: { principalId: row.agent_principal_id, displayName: row.agent_display_name },
    authorship: 'ai_written',
    markdown: row.body_markdown,
  };
}

function ledgerSummary(entry) {
  switch (entry.kind) {
    case 'decision': return entry.choice;
    case 'annotation': return `${entry.grouping} ${entry.group}: ${entry.label}`;
    case 'finding': return entry.statement;
    case 'issue': return entry.status === 'open' ? entry.observation : (entry.resolution || entry.observation);
    case 'check': return entry.note || '';
    case 'interpretation': return [entry.observation, `Meaning: ${entry.meaning}`, `Next: ${entry.nextStep}`].join('\n');
    case 'prediction': return entry.expectation;
    default: return '';
  }
}

function ledgerCell(row) {
  const entry = row.entry_json || {};
  const tab = isAgentNotebookTab(row.analysis_tab) ? row.analysis_tab : 'explore';
  return {
    kind: 'ledger',
    id: row.id,
    tab,
    tabLabel: agentNotebookTabLabel(tab),
    createdAt: iso(row.created_at),
    agent: { principalId: row.agent_principal_id, displayName: row.agent_display_name },
    authorship: 'ai_written',
    entryKind: entry.kind,
    title: entry.title,
    summary: ledgerSummary(entry),
    confidence: entry.confidence || null,
    sampleSupport: entry.sampleSupport || null,
    status: entry.status || null,
    item: entry.item || null,
    markers: entry.markers || [],
    alternatives: entry.alternatives || [],
    meaning: entry.meaning || null,
    test: entry.test || null,
    nextStep: entry.nextStep || null,
    outcome: entry.outcome || null,
    refersTo: entry.refersTo || null,
    evidence: entry.evidence || [],
  };
}

// Oldest first, so the notebook reads top to bottom; ties broken by id so
// the order is stable between reads.
function ordered(cells) {
  return cells.sort((a, b) => (time(a.createdAt) - time(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
}

function filterTab(cells, tab) {
  if (tab === undefined || tab === null || tab === '') return cells;
  if (!isAgentNotebookTab(tab)) throw codedError('INVALID_INPUT', `tab must be one of: ${AGENT_NOTEBOOK_TAB_IDS.join(', ')}.`, 400);
  return cells.filter((cell) => cell.tab === tab);
}

function notebook(cells, { tab, hiddenSandboxRuns = 0 } = {}) {
  const selected = ordered(filterTab(cells, tab));
  const counts = Object.fromEntries(AGENT_NOTEBOOK_TAB_IDS.map((id) => [id, 0]));
  for (const cell of cells) counts[cell.tab] = (counts[cell.tab] || 0) + 1;
  return {
    schema: 'traceomics.agent-notebook.v1',
    tabs: AGENT_NOTEBOOK_TABS.map((entry) => ({ ...entry, cellCount: counts[entry.id] || 0 })),
    tab: tab || null,
    cells: selected,
    hiddenSandboxRuns,
  };
}

const LEDGER_SELECT = `
  SELECT e.*, ap.display_name AS agent_display_name
    FROM agent_ledger_entries e
    JOIN agent_principals ap ON ap.id = e.agent_principal_id`;

const NOTE_SELECT = `
  SELECT n.*, ap.display_name AS agent_display_name
    FROM agent_notebook_notes n
    JOIN agent_principals ap ON ap.id = n.agent_principal_id`;

function createAgentNotebookService({ db, withTransaction, admission, sandboxes }) {
  async function objectivesFor(projectId, runs) {
    const ids = [...new Set(runs.map((run) => run.studyId).filter(Boolean))];
    const objectives = new Map();
    if (!ids.length) return objectives;
    const { rows } = await db.query(
      'SELECT id, objective FROM study_envelopes WHERE project_id = $1 AND id = ANY($2::text[])', [String(projectId), ids]);
    for (const row of rows) objectives.set(row.id, row.objective || '');
    return objectives;
  }

  async function readForHuman(actor, projectId, { tab } = {}) {
    requireHuman(actor);
    const membership = await db.requireProjectRole(actor.userId, projectId, READ_ROLES);
    const verified = admission ? (await admission.listRunsForHuman(actor, projectId)).runs : [];
    const sandbox = sandboxes ? await sandboxes.notebookRunsForHuman(actor, projectId) : { runs: [], hiddenRuns: 0 };
    const { rows: notes } = await db.query(
      `${NOTE_SELECT} WHERE n.project_id = $1 ORDER BY n.created_at DESC, n.id DESC LIMIT 1000`, [String(projectId)]);
    // Ledger entries cite the sponsor's private sandbox outputs, so they are
    // shown to the same people as those runs: the sponsor, owners and admins.
    const { rows: ledger } = await db.query(
      `${LEDGER_SELECT} WHERE e.project_id = $1 AND ($2::boolean OR e.sponsor_user_id = $3)
        ORDER BY e.created_at DESC, e.id DESC LIMIT 2000`,
      [String(projectId), MANAGE_ROLES.includes(membership?.role), actor.userId]);
    const objectives = await objectivesFor(projectId, verified);
    return notebook([
      ...verified.map((run) => verifiedCell(run, objectives)),
      ...sandbox.runs.map(agentCodeCell),
      ...notes.map(noteCell),
      ...ledger.map(ledgerCell),
    ], { tab, hiddenSandboxRuns: sandbox.hiddenRuns });
  }

  // An agent reads back its own cells, to continue where it left off.
  async function readForAgent(actor, { tab } = {}) {
    const projectId = actor.delegation.projectId;
    const verified = admission ? await admission.listRunsForAgent(actor, { limit: 100 }) : [];
    const sandbox = sandboxes ? await sandboxes.notebookRunsForAgent(actor) : { runs: [] };
    const { rows: notes } = await db.query(
      `${NOTE_SELECT} WHERE n.project_id = $1 AND n.delegation_id = $2 ORDER BY n.created_at DESC, n.id DESC LIMIT 1000`,
      [projectId, actor.delegation.id]);
    const { rows: ledger } = await db.query(
      `${LEDGER_SELECT} WHERE e.project_id = $1 AND e.delegation_id = $2 ORDER BY e.created_at DESC, e.id DESC LIMIT 2000`,
      [projectId, actor.delegation.id]);
    const objectives = await objectivesFor(projectId, verified);
    return notebook([
      ...verified.map((run) => verifiedCell(run, objectives)),
      ...sandbox.runs.map(agentCodeCell),
      ...notes.map(noteCell),
      ...ledger.map(ledgerCell),
    ], { tab });
  }

  async function addNoteForAgent(actor, body = {}) {
    rejectUnknown(body, ['requestId', 'tab', 'markdown']);
    if (!REQUEST_ID.test(String(body.requestId))) {
      throw codedError('INVALID_REQUEST_ID', 'requestId must be 8-80 letters, digits, "-" or "_".', 400);
    }
    if (!isAgentNotebookTab(body.tab)) {
      throw codedError('TAB_REQUIRED', `tab must be one of: ${AGENT_NOTEBOOK_TAB_IDS.join(', ')}.`, 400);
    }
    const markdown = typeof body.markdown === 'string' ? body.markdown.trim() : '';
    if (!markdown || markdown.length > MAX_NOTE_CHARS) {
      throw codedError('INVALID_INPUT', `markdown must be 1-${MAX_NOTE_CHARS} characters.`, 400);
    }
    const requestSha256 = crypto.createHash('sha256').update(JSON.stringify([body.tab, markdown])).digest('hex');
    return withTransaction(async (client) => {
      // Serializes this delegation's notes so the replay check and the cap
      // cannot race a concurrent write with the same requestId.
      await client.query('SELECT id FROM agent_delegations WHERE id = $1 FOR UPDATE', [actor.delegation.id]);
      const { rows: prior } = await client.query(
        `${NOTE_SELECT} WHERE n.delegation_id = $1 AND n.request_id = $2`, [actor.delegation.id, body.requestId]);
      if (prior[0]) {
        if (prior[0].request_sha256 !== requestSha256) {
          throw codedError('IDEMPOTENCY_CONFLICT', 'This requestId was already used for a different note.', 409);
        }
        return { note: noteCell(prior[0]), replayed: true };
      }
      const { rows: count } = await client.query(
        'SELECT COUNT(*)::int AS n FROM agent_notebook_notes WHERE delegation_id = $1', [actor.delegation.id]);
      if (count[0].n >= MAX_NOTES_PER_DELEGATION) {
        throw codedError('QUOTA_EXCEEDED', `This delegation already wrote ${MAX_NOTES_PER_DELEGATION} notebook notes.`, 409);
      }
      const id = `nbn_${crypto.randomBytes(12).toString('hex')}`;
      await client.query(
        `INSERT INTO agent_notebook_notes (id, project_id, delegation_id, agent_principal_id, sponsor_user_id,
           request_id, request_sha256, analysis_tab, body_markdown) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, actor.delegation.projectId, actor.delegation.id, actor.principalId, actor.sponsorUserId,
          body.requestId, requestSha256, body.tab, markdown]);
      await recordAutomationEvent(client, {
        projectId: actor.delegation.projectId, actor, action: 'notebook-note.written', decision: 'allowed',
        targetType: 'notebook_note', targetId: id, requestId: body.requestId,
      });
      const { rows } = await client.query(`${NOTE_SELECT} WHERE n.id = $1`, [id]);
      return { note: noteCell(rows[0]), replayed: false };
    });
  }

  return { readForHuman, readForAgent, addNoteForAgent };
}

module.exports = { createAgentNotebookService, MAX_NOTE_CHARS };
