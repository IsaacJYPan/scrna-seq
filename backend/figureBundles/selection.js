'use strict';

// Selection topo sort: given selected figures (or analysis objects), keep only
// the steps and objects those selections actually depend on, then order them
// so that every step appears after everything it reads.
//
// The analysis history is a set of per-object timelines. Each recorded step
// (a provenance record from the live session, or a durable job that produced
// an object) reads and writes named parts of a Seurat object's state. Walking
// a timeline backwards from a figure with a "still needed" set is ordinary
// backward liveness analysis: a step is kept only when it writes a part that a
// later kept step (or the figure) reads. Steps whose writes are never read —
// marker tables computed after the UMAP was saved, an unrelated subset in a
// sibling branch, exploratory re-clusterings that were overwritten — are left
// out. Unknown operations (custom R, console code) conservatively read and
// write every part, so nothing they might have touched is dropped.
//
// This module is pure: callers pass plain records and receive a plan. The
// database collector lives in ./index.js.

const STATE_PARTS = Object.freeze([
  'cells', 'counts', 'metadata', 'data', 'features', 'scaled', 'pca', 'clusters', 'umap', 'markers',
]);
const ALL = STATE_PARTS;

// reads / writes for each recorded operation. "load" has no reads: it is the
// start of a timeline. Keep this table conservative: over-reading only keeps
// an extra step, under-reading would produce a script that cannot reproduce.
const OPERATION_EFFECTS = Object.freeze({
  load: { reads: [], writes: ['cells', 'counts', 'metadata'] },
  'quality-control': { reads: ['cells', 'counts', 'metadata'], writes: ['cells', 'metadata'] },
  subset: { reads: ['cells', 'metadata', 'clusters'], writes: ['cells'] },
  normalize: { reads: ['cells', 'counts'], writes: ['data', 'features'] },
  integrate: { reads: ['cells', 'data', 'features', 'metadata'], writes: ['data', 'scaled', 'pca'] },
  pca: { reads: ['cells', 'data', 'features'], writes: ['scaled', 'pca'] },
  cluster: { reads: ['cells', 'pca'], writes: ['clusters', 'metadata'] },
  umap: { reads: ['cells', 'pca'], writes: ['umap'] },
  annotate: { reads: ['cells', 'clusters', 'metadata'], writes: ['clusters', 'metadata'] },
  deg: { reads: ['cells', 'data', 'clusters'], writes: ['markers'] },
  enrichment: { reads: ['markers'], writes: [] },
  cellchat: { reads: ['cells', 'data', 'clusters', 'metadata'], writes: [] },
  validation: { reads: ['cells', 'counts', 'metadata'], writes: [] },
  export: { reads: ALL, writes: [] },
});

// What a saved figure reads from the object it was drawn from.
const FIGURE_READS = Object.freeze({
  UMAP: ['cells', 'umap', 'clusters', 'metadata'],
  FeaturePlot: ['cells', 'umap', 'data', 'features'],
  DotPlot: ['cells', 'data', 'clusters', 'metadata'],
  Heatmap: ['cells', 'scaled', 'clusters', 'metadata'],
  Violin: ['cells', 'data', 'clusters', 'metadata'],
  GeneExpression: ['cells', 'data', 'umap', 'metadata'],
});

function operationEffects(operation) {
  return OPERATION_EFFECTS[operation] || { reads: ALL, writes: ALL, conservative: true };
}

function figureReads(plotType) {
  return FIGURE_READS[plotType] || ALL;
}

function time(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareChronological(a, b) {
  return time(a.createdAt) - time(b.createdAt)
    || (Number(a.sequence) || 0) - (Number(b.sequence) || 0)
    || String(a.id).localeCompare(String(b.id));
}

const MAX_VISITS = 2000;

/**
 * Build the minimal dependency plan for a selection.
 *
 * @param {object} graph
 * @param {Map<string, object>} graph.objects   id -> { id, objectType, datasetId, createdAt, parents: [{ parentId, edgeType, jobId, createdAt }] }
 * @param {Map<string, object[]>} graph.records objectId -> provenance records { id, operation, createdAt, parentIds }
 * @param {Map<string, object>} graph.producingJobs objectId -> job { id, jobType, createdAt, analysisObjectId }
 * @param {Map<string, object>} [graph.recordsById] provenance id -> record (for explicit parent links)
 * @param {object[]} seeds  [{ id, kind: 'figure'|'object', objectId, plotType?, createdAt?, provenanceId? }]
 */
function planSelection(graph, seeds) {
  const nodes = new Map(); // id -> node
  const edges = new Set(); // "from\u0000to"
  const unresolved = new Map(); // objectId -> Set(parts) satisfied by nothing recorded
  const memo = new Set();
  let visits = 0;
  const recordsById = graph.recordsById || new Map();

  const addNode = (node) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return nodes.get(node.id);
  };
  const addEdge = (from, to) => {
    if (from && to && from !== to) edges.add(`${from}\u0000${to}`);
  };
  const objectNode = (objectId) => {
    const object = graph.objects.get(objectId);
    return addNode({
      id: objectId, kind: 'object', objectId,
      createdAt: object?.createdAt, objectType: object?.objectType || null,
      datasetId: object?.datasetId || null,
    });
  };

  // needed: Map(part -> Set(consumerNodeId)). Resolves within objectId's
  // timeline at or before cutoff, then crosses into the object's parents.
  function resolve(objectId, needed, cutoff) {
    if (needed.size === 0) return;
    if (++visits > MAX_VISITS) {
      const error = new Error('Selection is too large to plan.');
      error.code = 'SELECTION_TOO_LARGE';
      throw error;
    }
    const object = graph.objects.get(objectId);
    if (!object) {
      const missing = unresolved.get(objectId) || new Set();
      for (const part of needed.keys()) missing.add(part);
      unresolved.set(objectId, missing);
      return;
    }
    objectNode(objectId);
    const timeline = (graph.records.get(objectId) || [])
      .filter((record) => cutoff == null || time(record.createdAt) <= cutoff)
      .slice()
      .sort(compareChronological)
      .reverse();
    for (const record of timeline) {
      if (needed.size === 0) break;
      const effects = operationEffects(record.operation);
      const satisfied = effects.writes.filter((part) => needed.has(part));
      if (satisfied.length === 0) continue;
      addNode({
        id: record.id, kind: 'step', objectId, operation: record.operation,
        createdAt: record.createdAt, sequence: record.sequence, conservative: Boolean(effects.conservative),
      });
      addEdge(objectId, record.id);
      for (const part of satisfied) {
        for (const consumer of needed.get(part)) addEdge(record.id, consumer);
        needed.delete(part);
      }
      for (const part of effects.reads) {
        if (!needed.has(part)) needed.set(part, new Set());
        needed.get(part).add(record.id);
      }
      // Explicit links recorded with the step are always honoured, even when
      // the effect table would not have required them.
      for (const parentId of record.parentIds || []) {
        const parent = recordsById.get(parentId);
        if (!parent || !graph.objects.has(parent.objectId)) continue;
        const key = `explicit:${parent.id}->${record.id}`;
        if (memo.has(key)) continue;
        memo.add(key);
        resolveExact(parent, record.id);
      }
    }
    if (needed.size === 0) return;

    // The rest of the state came from whatever created this object.
    const job = graph.producingJobs.get(objectId);
    let boundary = objectId;
    if (job) {
      addNode({ id: job.id, kind: 'job', objectId, jobType: job.jobType, createdAt: job.createdAt });
      addEdge(job.id, objectId);
      for (const consumers of needed.values()) for (const consumer of consumers) addEdge(job.id, consumer);
      boundary = job.id;
      // A durable job reads its whole input object.
      needed = new Map(ALL.map((part) => [part, new Set([job.id])]));
    } else {
      for (const consumers of needed.values()) for (const consumer of consumers) addEdge(objectId, consumer);
      needed = new Map([...needed.keys()].map((part) => [part, new Set([objectId])]));
    }
    const parents = (object.parents || []).slice().sort((a, b) => String(a.parentId).localeCompare(String(b.parentId)));
    if (parents.length === 0) {
      if (!job) {
        const missing = unresolved.get(objectId) || new Set();
        for (const part of needed.keys()) if (part !== 'markers') missing.add(part);
        if (missing.size > 0) unresolved.set(objectId, missing);
      }
      return;
    }
    for (const parent of parents) {
      const parentCutoff = time(parent.createdAt || object.createdAt) || null;
      const key = `${parent.parentId}@${parentCutoff}:${[...needed.keys()].sort().join(',')}`;
      objectNode(parent.parentId);
      addEdge(parent.parentId, boundary);
      if (memo.has(key)) {
        // Already resolved for the same parts; still connect the boundary to
        // the parent's kept steps through the object edge above.
        continue;
      }
      memo.add(key);
      const forParent = new Map([...needed.keys()].map((part) => [part, new Set([boundary])]));
      resolve(parent.parentId, forParent, parentCutoff);
    }
  }

  // Keep an explicitly linked record and what it in turn needs.
  function resolveExact(record, consumerId) {
    const effects = operationEffects(record.operation);
    addNode({
      id: record.id, kind: 'step', objectId: record.objectId, operation: record.operation,
      createdAt: record.createdAt, conservative: Boolean(effects.conservative),
    });
    addEdge(record.objectId, record.id);
    addEdge(record.id, consumerId);
    const needs = new Map(effects.reads.map((part) => [part, new Set([record.id])]));
    resolve(record.objectId, needs, time(record.createdAt) - 1);
  }

  for (const seed of seeds) {
    if (seed.kind === 'figure') {
      addNode({
        id: seed.id, kind: 'figure', objectId: seed.objectId || null,
        plotType: seed.plotType || 'Unknown', createdAt: seed.createdAt,
      });
      if (seed.provenanceId && recordsById.has(seed.provenanceId)) {
        resolveExact(recordsById.get(seed.provenanceId), seed.id);
      }
      if (!seed.objectId) continue;
      objectNode(seed.objectId);
      addEdge(seed.objectId, seed.id);
      const needs = new Map(figureReads(seed.plotType).map((part) => [part, new Set([seed.id])]));
      resolve(seed.objectId, needs, seed.createdAt ? time(seed.createdAt) : null);
    } else {
      // An object selected on its own needs everything that shaped its
      // current state, so resolve its full timeline.
      objectNode(seed.objectId);
      const marker = `seed:${seed.objectId}`;
      addNode({ id: marker, kind: 'selection', objectId: seed.objectId, createdAt: null });
      addEdge(seed.objectId, marker);
      const needs = new Map(ALL.map((part) => [part, new Set([marker])]));
      resolve(seed.objectId, needs, null);
    }
  }

  const order = topologicalOrder([...nodes.values()], [...edges].map((key) => key.split('\u0000')));
  return {
    order: order.filter((node) => node.kind !== 'selection'),
    edges: [...edges].map((key) => {
      const [from, to] = key.split('\u0000');
      return { from, to };
    }).filter((edge) => !edge.to.startsWith('seed:') && !edge.from.startsWith('seed:')),
    unresolved: [...unresolved.entries()].map(([objectId, parts]) => ({ objectId, parts: [...parts].sort() })),
  };
}

const KIND_RANK = { object: 0, job: 1, step: 2, figure: 3, selection: 4 };

// Kahn's algorithm with a deterministic tie-break (time, kind, id) so the same
// selection always produces byte-identical scripts.
function topologicalOrder(nodes, edgePairs) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const [from, to] of edgePairs) {
    if (!byId.has(from) || !byId.has(to)) continue;
    outgoing.get(from).push(to);
    indegree.set(to, indegree.get(to) + 1);
  }
  const compare = (a, b) => {
    const left = byId.get(a);
    const right = byId.get(b);
    return (time(left.createdAt) - time(right.createdAt))
      || (KIND_RANK[left.kind] - KIND_RANK[right.kind])
      || (Number(left.sequence) || 0) - (Number(right.sequence) || 0)
      || String(a).localeCompare(String(b));
  };
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id).sort(compare);
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(byId.get(id));
    let changed = false;
    for (const next of outgoing.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) { ready.push(next); changed = true; }
    }
    if (changed) ready.sort(compare);
  }
  if (order.length !== nodes.length) {
    const error = new Error('The selected history contains a dependency cycle.');
    error.code = 'SELECTION_CYCLE';
    error.remaining = nodes.filter((node) => !order.includes(node)).map((node) => node.id);
    throw error;
  }
  return order;
}

module.exports = {
  STATE_PARTS, OPERATION_EFFECTS, FIGURE_READS,
  operationEffects, figureReads, planSelection, topologicalOrder,
};
