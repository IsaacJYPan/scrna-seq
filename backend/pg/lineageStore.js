'use strict';

// Analysis-object lineage: the parent/child edges between saved analyses, the
// cycle check that keeps them a DAG, and bounded graph walks for display. Edges
// never cross a project boundary, and project reads only return edges whose
// endpoints the caller can see.

function createLineageStore({
  connect, query, genId, codedError, assertPlainObject, requireProjectRole,
  getProjectAnalysisObject, limits, vocabulary, idPatterns, readRoles,
}) {
  function rowToAnalysisObjectEdge(row) {
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      parentAnalysisObjectId: row.parent_analysis_object_id,
      childAnalysisObjectId: row.child_analysis_object_id,
      jobId: row.job_id,
      edgeType: row.edge_type,
      parentRole: row.parent_role,
      metadata: JSON.parse(row.metadata_json || '{}'),
      createdByUserId: Number(row.created_by_user_id),
      createdAt: row.created_at
    };
  }

  async function insertLineageEdgeRow(client, {
    projectId, parentObjectId, childObjectId, jobId, edgeType, parentRole, metadata, createdByUserId
  }) {
    const id = genId('aoe');
    await client.query(
      `INSERT INTO analysis_object_edges
         (id, project_id, parent_analysis_object_id, child_analysis_object_id, job_id,
          edge_type, parent_role, metadata_json, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        projectId || null,
        String(parentObjectId),
        String(childObjectId),
        jobId || null,
        edgeType,
        parentRole,
        JSON.stringify(metadata || {}),
        Number(createdByUserId)
      ]
    );
    return id;
  }

  async function getLineageEdges(column, objectId, projectScope) {
    const params = [String(objectId)];
    let where = `${column} = $1`;
    if (projectScope && projectScope.projectId !== undefined) {
      if (projectScope.projectId === null) {
        where += ' AND project_id IS NULL';
      } else {
        params.push(String(projectScope.projectId));
        where += ` AND project_id = $${params.length}`;
      }
    }
    const { rows } = await query(
      `SELECT * FROM analysis_object_edges WHERE ${where} ORDER BY created_at ASC, id ASC`,
      params
    );
    return rows;
  }

  function getLineageEdgesByParent(parentObjectId, projectScope) {
    return getLineageEdges('parent_analysis_object_id', parentObjectId, projectScope);
  }

  function getLineageEdgesByChild(childObjectId, projectScope) {
    return getLineageEdges('child_analysis_object_id', childObjectId, projectScope);
  }

  async function lineageEdgeWouldCreateCycle(parentObjectId, childObjectId, projectScope) {
    if (parentObjectId === childObjectId) return true;
    const seen = new Set([String(childObjectId)]);
    let frontier = [String(childObjectId)];
    let visited = 0;
    while (frontier.length > 0) {
      const next = [];
      for (const node of frontier) {
        if (++visited > limits.maxNodes) return true;
        const children = await getLineageEdgesByParent(node, projectScope);
        for (const edge of children) {
          const child = edge.child_analysis_object_id;
          if (child === String(parentObjectId)) return true;
          if (!seen.has(child)) {
            seen.add(child);
            next.push(child);
          }
        }
      }
      frontier = next;
    }
    return false;
  }

  async function createLineageEdge(actorUserId, input = {}) {
    const parentObjectId = typeof input.parentObjectId === 'string' ? input.parentObjectId : '';
    const childObjectId = typeof input.childObjectId === 'string' ? input.childObjectId : '';
    if (!idPatterns.analysisObject.test(parentObjectId)) throw codedError('INVALID_PARENT_ID', 'Malformed parent analysis object ID.');
    if (!idPatterns.analysisObject.test(childObjectId)) throw codedError('INVALID_CHILD_ID', 'Malformed child analysis object ID.');
    if (parentObjectId === childObjectId) throw codedError('SELF_PARENT', 'An analysis object cannot be its own parent.');
    const edgeType = input.edgeType === undefined || input.edgeType === null ? 'derived_from' : String(input.edgeType);
    if (!vocabulary.edgeTypes.has(edgeType)) {
      throw codedError('INVALID_EDGE_TYPE', `Invalid edgeType. Allowed: ${[...vocabulary.edgeTypes].join(', ')}.`);
    }
    const parentRole = input.parentRole === undefined || input.parentRole === null ? 'primary' : String(input.parentRole);
    if (!vocabulary.parentRoles.has(parentRole)) {
      throw codedError('INVALID_PARENT_ROLE', `Invalid parentRole. Allowed: ${[...vocabulary.parentRoles].join(', ')}.`);
    }
    const metadata = input.metadata === undefined ? {} : input.metadata;
    assertPlainObject(metadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
    let jobId = null;
    if (input.jobId !== undefined && input.jobId !== null) {
      if (!idPatterns.job.test(String(input.jobId))) throw codedError('INVALID_JOB_ID', 'Malformed job ID.');
      jobId = String(input.jobId);
    }
    const { rows: objectRows } = await query(
      `SELECT id, project_id FROM analysis_objects WHERE id IN ($1, $2)`,
      [parentObjectId, childObjectId]
    );
    const byId = new Map(objectRows.map(r => [r.id, r]));
    const parent = byId.get(parentObjectId);
    const child = byId.get(childObjectId);
    if (!parent) throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
    if (!child) throw codedError('CHILD_NOT_FOUND', 'Child analysis object not found.');
    const sameScope = parent.project_id === child.project_id ||
      (parent.project_id == null && child.project_id == null);
    if (!sameScope) throw codedError('CHILD_NOT_FOUND', 'Child analysis object not found.');
    const projectId = parent.project_id || null;
    if (jobId) {
      const { rows } = await query('SELECT id, project_id FROM jobs WHERE id = $1', [jobId]);
      const job = rows[0];
      const jobSameScope = job && (job.project_id === projectId || (job.project_id == null && projectId == null));
      if (!jobSameScope) throw codedError('JOB_NOT_FOUND', 'Job not found.');
    }
    const scope = { projectId };
    if (await lineageEdgeWouldCreateCycle(parentObjectId, childObjectId, scope)) {
      throw codedError('CYCLE', 'This edge would create a cycle in the lineage graph.');
    }
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      const id = await insertLineageEdgeRow(client, {
        projectId, parentObjectId, childObjectId, jobId, edgeType, parentRole,
        metadata, createdByUserId: actorUserId
      });
      await client.query('COMMIT');
      const { rows } = await query('SELECT * FROM analysis_object_edges WHERE id = $1', [id]);
      return rowToAnalysisObjectEdge(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err && err.code === '23505') throw codedError('DUPLICATE_EDGE', 'An identical lineage edge already exists.');
      throw err;
    } finally {
      client.release();
    }
  }

  async function listLineageParents(objectId, projectScope) {
    return (await getLineageEdgesByChild(objectId, projectScope)).map(rowToAnalysisObjectEdge);
  }

  async function listLineageChildren(objectId, projectScope) {
    return (await getLineageEdgesByParent(objectId, projectScope)).map(rowToAnalysisObjectEdge);
  }

  async function buildLineageGraph(objectId, projectScope, nodeFetcher) {
    const start = String(objectId);
    const edgeById = new Map();
    const nodeIds = new Set([start]);
    let truncated = false;
    async function walk(direction) {
      const seen = new Set([start]);
      let frontier = [start];
      let depth = 0;
      while (frontier.length > 0) {
        if (++depth > limits.maxDepth) { truncated = true; break; }
        const next = [];
        for (const node of frontier) {
          const edges = direction === 'down'
            ? await getLineageEdgesByParent(node, projectScope)
            : await getLineageEdgesByChild(node, projectScope);
          for (const edge of edges) {
            if (!edgeById.has(edge.id)) edgeById.set(edge.id, edge);
            const neighbor = direction === 'down'
              ? edge.child_analysis_object_id : edge.parent_analysis_object_id;
            if (nodeIds.size < limits.maxNodes) nodeIds.add(neighbor);
            else truncated = true;
            if (!seen.has(neighbor) && nodeIds.has(neighbor)) {
              seen.add(neighbor);
              next.push(neighbor);
            }
          }
        }
        frontier = next;
      }
    }
    await walk('down');
    await walk('up');
    const nodes = [];
    for (const id of [...nodeIds].sort()) {
      const node = await nodeFetcher(id);
      if (node) nodes.push(node);
    }
    const edges = [...edgeById.values()]
      .map(rowToAnalysisObjectEdge)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1
        : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
    return { objectId: start, nodes, edges, truncated };
  }

  async function listProjectAnalysisObjectParents(userId, projectId, objectId) {
    await requireProjectRole(userId, projectId, readRoles);
    const pid = String(projectId);
    if (!(await getProjectAnalysisObject(userId, pid, objectId))) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    const edges = await listLineageParents(objectId, { projectId: pid });
    const visible = await Promise.all(edges.map(async (edge) => (
      (await getProjectAnalysisObject(userId, pid, edge.parentAnalysisObjectId)) ? edge : null
    )));
    return visible.filter(Boolean);
  }

  async function listProjectAnalysisObjectChildren(userId, projectId, objectId) {
    await requireProjectRole(userId, projectId, readRoles);
    const pid = String(projectId);
    if (!(await getProjectAnalysisObject(userId, pid, objectId))) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    const edges = await listLineageChildren(objectId, { projectId: pid });
    const visible = await Promise.all(edges.map(async (edge) => (
      (await getProjectAnalysisObject(userId, pid, edge.childAnalysisObjectId)) ? edge : null
    )));
    return visible.filter(Boolean);
  }

  async function getProjectAnalysisObjectLineage(userId, projectId, objectId) {
    await requireProjectRole(userId, projectId, readRoles);
    const pid = String(projectId);
    const root = await getProjectAnalysisObject(userId, pid, objectId);
    if (!root) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    const graph = await buildLineageGraph(objectId, { projectId: pid }, async (id) => {
      const object = await getProjectAnalysisObject(userId, pid, id);
      return object ? {
        id: object.id,
        label: object.displayName || null,
        objectType: object.objectType,
        lineageRootId: object.lineageRootId,
        createdAt: object.createdAt,
      } : null;
    });
    const visibleNodeIds = new Set(graph.nodes.map((node) => node.id));
    return {
      ...graph,
      edges: graph.edges.filter((edge) => (
        visibleNodeIds.has(edge.parentAnalysisObjectId)
        && visibleNodeIds.has(edge.childAnalysisObjectId)
      )),
      projectId: pid,
      rootObjectId: root.lineageRootId || root.id,
    };
  }

  return {
    rowToAnalysisObjectEdge,
    insertLineageEdgeRow,
    lineageEdgeWouldCreateCycle,
    createLineageEdge,
    listLineageParents,
    listLineageChildren,
    buildLineageGraph,
    listProjectAnalysisObjectParents,
    listProjectAnalysisObjectChildren,
    getProjectAnalysisObjectLineage,
  };
}

module.exports = { createLineageStore };
