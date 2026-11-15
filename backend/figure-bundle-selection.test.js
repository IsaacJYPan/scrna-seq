import { describe, it, expect } from 'vitest';

const { planSelection, topologicalOrder } = require('./figureBundles/selection');
const { figureScript, normalizeSelection } = require('./figureBundles');

const t = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function graph({ objects, records = [], jobs = [] }) {
  const objectMap = new Map(objects.map((object) => [object.id, { parents: [], ...object }]));
  const byObject = new Map();
  const byId = new Map();
  for (const record of records) {
    byId.set(record.id, record);
    if (!byObject.has(record.objectId)) byObject.set(record.objectId, []);
    byObject.get(record.objectId).push(record);
  }
  return {
    objects: objectMap,
    records: byObject,
    recordsById: byId,
    producingJobs: new Map(jobs.map((job) => [job.objectId, job])),
  };
}

const ids = (plan, kind) => plan.order.filter((node) => !kind || node.kind === kind).map((node) => node.id);

describe('selection topo sort', () => {
  const linear = graph({
    objects: [{ id: 'ao_1', createdAt: t(0) }],
    records: [
      { id: 'p_load', objectId: 'ao_1', operation: 'load', createdAt: t(1) },
      { id: 'p_qc', objectId: 'ao_1', operation: 'quality-control', createdAt: t(2) },
      { id: 'p_norm', objectId: 'ao_1', operation: 'normalize', createdAt: t(3) },
      { id: 'p_pca', objectId: 'ao_1', operation: 'pca', createdAt: t(4) },
      { id: 'p_clu', objectId: 'ao_1', operation: 'cluster', createdAt: t(5) },
      { id: 'p_umap', objectId: 'ao_1', operation: 'umap', createdAt: t(6) },
      { id: 'p_deg', objectId: 'ao_1', operation: 'deg', createdAt: t(7) },
      { id: 'p_enr', objectId: 'ao_1', operation: 'enrichment', createdAt: t(8) },
    ],
  });

  it('keeps every step a UMAP reads and drops marker work it never reads', () => {
    const plan = planSelection(linear, [{ id: 'fig_a', kind: 'figure', objectId: 'ao_1', plotType: 'UMAP', createdAt: t(9) }]);
    expect(ids(plan, 'step')).toEqual(['p_load', 'p_qc', 'p_norm', 'p_pca', 'p_clu', 'p_umap']);
    expect(ids(plan).at(-1)).toBe('fig_a');
    expect(plan.unresolved).toEqual([]);
  });

  it('ignores steps recorded after the figure was saved', () => {
    const plan = planSelection(linear, [{ id: 'fig_a', kind: 'figure', objectId: 'ao_1', plotType: 'UMAP', createdAt: t(5) + '' }]);
    // Saved after clustering but before UMAP existed; UMAP part is unresolved.
    expect(ids(plan, 'step')).not.toContain('p_umap');
    expect(plan.unresolved).toEqual([{ objectId: 'ao_1', parts: ['umap'] }]);
  });

  it('a feature plot does not need clustering', () => {
    const plan = planSelection(linear, [{ id: 'fig_f', kind: 'figure', objectId: 'ao_1', plotType: 'FeaturePlot', createdAt: t(9) }]);
    expect(ids(plan, 'step')).toEqual(['p_load', 'p_qc', 'p_norm', 'p_pca', 'p_umap']);
  });

  it('an overwritten clustering is pruned; only the last one before the figure is kept', () => {
    const g = graph({
      objects: [{ id: 'ao_1', createdAt: t(0) }],
      records: [
        { id: 'p_load', objectId: 'ao_1', operation: 'load', createdAt: t(1) },
        { id: 'p_norm', objectId: 'ao_1', operation: 'normalize', createdAt: t(2) },
        { id: 'p_pca', objectId: 'ao_1', operation: 'pca', createdAt: t(3) },
        { id: 'p_clu1', objectId: 'ao_1', operation: 'cluster', createdAt: t(4) },
        { id: 'p_clu2', objectId: 'ao_1', operation: 'cluster', createdAt: t(5) },
        { id: 'p_umap', objectId: 'ao_1', operation: 'umap', createdAt: t(6) },
      ],
    });
    const plan = planSelection(g, [{ id: 'fig', kind: 'figure', objectId: 'ao_1', plotType: 'DotPlot', createdAt: t(9) }]);
    expect(ids(plan, 'step')).toEqual(['p_load', 'p_norm', 'p_pca', 'p_clu2']);
  });

  it('unknown custom code is kept conservatively and pulls in what precedes it', () => {
    const g = graph({
      objects: [{ id: 'ao_1', createdAt: t(0) }],
      records: [
        { id: 'p_load', objectId: 'ao_1', operation: 'load', createdAt: t(1) },
        { id: 'p_deg', objectId: 'ao_1', operation: 'deg', createdAt: t(2) },
        { id: 'p_custom', objectId: 'ao_1', operation: 'unknown', createdAt: t(3) },
      ],
    });
    const plan = planSelection(g, [{ id: 'fig', kind: 'figure', objectId: 'ao_1', plotType: 'Violin', createdAt: t(9) }]);
    expect(ids(plan, 'step')).toEqual(['p_load', 'p_deg', 'p_custom']);
    expect(plan.order.find((node) => node.id === 'p_custom').conservative).toBe(true);
  });

  it('crosses checkpoints into the parent only up to the fork time and skips sibling branches', () => {
    const g = graph({
      objects: [
        { id: 'ao_root', createdAt: t(0) },
        { id: 'ao_child', createdAt: t(4), parents: [{ parentId: 'ao_root', edgeType: 'checkpoint', createdAt: t(4) }] },
        { id: 'ao_sibling', createdAt: t(5), parents: [{ parentId: 'ao_root', edgeType: 'branch', createdAt: t(5) }] },
      ],
      records: [
        { id: 'r_load', objectId: 'ao_root', operation: 'load', createdAt: t(1) },
        { id: 'r_norm', objectId: 'ao_root', operation: 'normalize', createdAt: t(2) },
        { id: 'r_pca', objectId: 'ao_root', operation: 'pca', createdAt: t(3) },
        { id: 'r_late', objectId: 'ao_root', operation: 'subset', createdAt: t(6) },
        { id: 'c_umap', objectId: 'ao_child', operation: 'umap', createdAt: t(7) },
        { id: 'c_clu', objectId: 'ao_child', operation: 'cluster', createdAt: t(8) },
        { id: 's_clu', objectId: 'ao_sibling', operation: 'cluster', createdAt: t(9) },
      ],
    });
    const plan = planSelection(g, [{ id: 'fig', kind: 'figure', objectId: 'ao_child', plotType: 'UMAP', createdAt: t(10) }]);
    expect(ids(plan, 'step')).toEqual(['r_load', 'r_norm', 'r_pca', 'c_umap', 'c_clu']);
    expect(ids(plan, 'object')).toEqual(['ao_root', 'ao_child']);
    const order = ids(plan);
    expect(order.indexOf('r_pca')).toBeLessThan(order.indexOf('ao_child'));
  });

  it('a job-produced object depends on the whole parent state, and the job precedes its object', () => {
    const g = graph({
      objects: [
        { id: 'ao_in', createdAt: t(0) },
        { id: 'ao_out', createdAt: t(5), parents: [{ parentId: 'ao_in', edgeType: 'derived_from', createdAt: t(5) }] },
      ],
      records: [
        { id: 'i_load', objectId: 'ao_in', operation: 'load', createdAt: t(1) },
        { id: 'i_deg', objectId: 'ao_in', operation: 'deg', createdAt: t(2) },
      ],
      jobs: [{ id: 'job_1', objectId: 'ao_out', jobType: 'trusted.method.v1', createdAt: t(4) }],
    });
    const plan = planSelection(g, [{ id: 'fig', kind: 'figure', objectId: 'ao_out', plotType: 'UMAP', createdAt: t(9) }]);
    expect(ids(plan, 'step')).toEqual(['i_load', 'i_deg']);
    const order = ids(plan);
    expect(order.indexOf('i_deg')).toBeLessThan(order.indexOf('job_1'));
    expect(order.indexOf('job_1')).toBeLessThan(order.indexOf('fig'));
  });

  it('merges several figures into one shared, de-duplicated plan', () => {
    const plan = planSelection(linear, [
      { id: 'fig_u', kind: 'figure', objectId: 'ao_1', plotType: 'UMAP', createdAt: t(9) },
      { id: 'fig_f', kind: 'figure', objectId: 'ao_1', plotType: 'FeaturePlot', createdAt: t(9) },
    ]);
    const steps = ids(plan, 'step');
    expect(new Set(steps).size).toBe(steps.length);
    expect(steps).toEqual(['p_load', 'p_qc', 'p_norm', 'p_pca', 'p_clu', 'p_umap']);
  });

  it('honours an explicit provenance link on the figure', () => {
    const plan = planSelection(linear, [
      { id: 'fig', kind: 'figure', objectId: 'ao_1', plotType: 'UMAP', createdAt: t(9), provenanceId: 'p_enr' },
    ]);
    expect(ids(plan, 'step')).toEqual(expect.arrayContaining(['p_deg', 'p_enr']));
  });

  it('is deterministic and detects cycles', () => {
    const a = planSelection(linear, [{ id: 'fig', kind: 'figure', objectId: 'ao_1', plotType: 'UMAP', createdAt: t(9) }]);
    const b = planSelection(linear, [{ id: 'fig', kind: 'figure', objectId: 'ao_1', plotType: 'UMAP', createdAt: t(9) }]);
    expect(ids(a)).toEqual(ids(b));
    expect(() => topologicalOrder([{ id: 'x', kind: 'step' }, { id: 'y', kind: 'step' }], [['x', 'y'], ['y', 'x']]))
      .toThrowError(/cycle/);
  });
});

describe('figure bundle helpers', () => {
  it('validates selections', () => {
    expect(() => normalizeSelection({})).toThrowError(/at least one/);
    expect(() => normalizeSelection({ figureIds: ['nope'] })).toThrowError(/Malformed/);
    expect(normalizeSelection({ figureIds: ['fig_ab', 'fig_ab'] }).figureIds).toEqual(['fig_ab']);
  });

  it('writes a plotting step that quotes user text safely', () => {
    const script = figureScript({
      id: 'fig_1', plotType: 'DotPlot', title: 'Fig 2"; system("x")',
      params: { features: ['CD3E', 'MS4A1"); system("rm'], group_by: 'seurat_clusters', format: 'pdf' },
    });
    expect(script).toContain('DotPlot(obj, features = c("CD3E", "MS4A1\\"); system(\\"rm")');
    expect(script).toContain('figures/fig-2-system-x.pdf');
    expect(script).not.toMatch(/^system/m);
  });
});
