/**
 * The agent notebook read model: where each kind of agent work is filed and
 * in what order. Database-backed behaviour (notes, sandbox visibility,
 * append-only tables) is covered in agent-sandboxes.test.js.
 */
import { describe, expect, it } from 'vitest';

const { createAgentNotebookService } = require('./agentNotebook/notebook');
const { tabForRelease, AGENT_NOTEBOOK_TAB_IDS } = require('../shared/agentNotebookTabs.mjs');
const trustedMethods = require('./workflowTrust/trustedMethods');

const human = { kind: 'human', userId: 7 };
const agent = { displayName: 'Analyst agent' };

function verifiedRun(id, release, createdAt, extra = {}) {
  return {
    id, studyId: 'study_1', studyName: 'Doublets', trialNumber: 1, agent, release, choices: { a: 1 },
    inputs: { analysisObjectId: 'obj_1' }, state: 'candidate_ready', acceptance: 'none', createdAt, ...extra,
  };
}

function service({ verified = [], sandboxRuns = [], notes = [], hiddenRuns = 0 } = {}) {
  const queries = [];
  const db = {
    requireProjectRole: async () => ({ role: 'viewer' }),
    query: async (sql, params) => {
      queries.push([sql, params]);
      if (sql.includes('FROM study_envelopes')) return { rows: [{ id: 'study_1', objective: 'Remove doublets first.' }] };
      if (sql.includes('FROM agent_notebook_notes')) return { rows: notes };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return {
    queries,
    notebook: createAgentNotebookService({
      db, withTransaction: async () => { throw new Error('not used'); },
      admission: { listRunsForHuman: async () => ({ runs: verified }) },
      sandboxes: { notebookRunsForHuman: async () => ({ runs: sandboxRuns, hiddenRuns }) },
    }),
  };
}

describe('agent notebook tabs', () => {
  it('files built-in workflows by job type and library methods by category', () => {
    expect(tabForRelease({ jobType: 'deg.find_markers.v1' })).toBe('deg');
    expect(tabForRelease({ jobType: 'enrichment.gsea.v1' })).toBe('enrichment');
    expect(tabForRelease({ jobType: 'cellchat.infer.v1' })).toBe('cellchat');
    expect(tabForRelease({ jobType: 'seurat.multisample.v1' })).toBe('integrate');
    expect(tabForRelease({ jobType: 'something.new.v1' })).toBe('explore');
    expect(tabForRelease({ jobType: 'trusted.method.v1' }, { methodCategory: 'qc' })).toBe('qc');
    expect(tabForRelease({ jobType: 'trusted.method.v1' }, { methodCategory: 'annotation' })).toBe('cluster');
  });

  it('places every trusted library method under a known tab', () => {
    const { methods } = trustedMethods.loadLibrary();
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      const tab = tabForRelease({ key: method.key, jobType: trustedMethods.JOB_TYPE }, { methodCategory: method.category });
      expect(AGENT_NOTEBOOK_TAB_IDS, `${method.key} (${method.category})`).toContain(tab);
    }
  });
});

describe('agent notebook read model', () => {
  it('merges verified runs, agent scripts and notes oldest first, with the study objective', async () => {
    const { notebook } = service({
      verified: [
        verifiedRun('run_2', { id: 'rel_m', key: 'seurat-markers', version: '1', jobType: 'deg.find_markers.v1' }, '2026-11-20T10:03:00Z'),
        verifiedRun('run_1', { id: 'rel_d', key: 'doublets-scdblfinder', version: '1', jobType: 'trusted.method.v1' }, '2026-11-20T10:01:00Z'),
      ],
      sandboxRuns: [{ id: 'sbr_1', tab: null, title: 'Old run', agent, createdAt: '2026-11-20T10:02:00Z', review: { state: 'draft' }, state: 'draft_ready' }],
      notes: [{ id: 'nbn_1', analysis_tab: 'qc', body_markdown: 'Start with QC.', agent_principal_id: 'ap_1',
        agent_display_name: 'Analyst agent', created_at: new Date('2026-11-20T10:00:00Z') }],
      hiddenRuns: 3,
    });
    const book = await notebook.readForHuman(human, 'proj_1');
    expect(book.cells.map((c) => [c.id, c.kind, c.tab])).toEqual([
      ['nbn_1', 'note', 'qc'],
      ['run_1', 'verified', 'qc'],
      ['sbr_1', 'agent_code', 'explore'],
      ['run_2', 'verified', 'deg'],
    ]);
    expect(book.cells[1]).toMatchObject({
      authorship: 'verified', study: { objective: 'Remove doublets first.' },
      release: { title: 'Doublet detection (scDblFinder)' }, inputAnalysisObjectId: 'obj_1',
    });
    expect(book.cells[2]).toMatchObject({ authorship: 'ai_written', tabAssigned: false });
    expect(book.cells[0]).toMatchObject({ authorship: 'ai_written', markdown: 'Start with QC.', createdAt: '2026-11-20T10:00:00.000Z' });
    expect(book.tabs.find((t) => t.id === 'qc').cellCount).toBe(2);
    expect(book.hiddenSandboxRuns).toBe(3);

    const deg = await notebook.readForHuman(human, 'proj_1', { tab: 'deg' });
    expect(deg.cells.map((c) => c.id)).toEqual(['run_2']);
    expect(deg.tabs.find((t) => t.id === 'qc').cellCount).toBe(2);
    await expect(notebook.readForHuman(human, 'proj_1', { tab: 'bogus' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('is for people; agents read their own cells through the automation API', async () => {
    const { notebook } = service();
    await expect(notebook.readForHuman({ kind: 'agent' }, 'proj_1')).rejects.toMatchObject({ code: 'HUMAN_ACTOR_REQUIRED' });
  });
});
