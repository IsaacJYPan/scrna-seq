// Convert R responses into public result summaries with field and size limits.

const crypto = require('crypto');
const { MAX_CELLCHAT_RESULT_ROWS } = require('../cellChatInference');

function sanitizeRuntimeField(value, maxLen = 64) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }
  const cleaned = String(value)
    .replace(/[^A-Za-z0-9 ._:+-]/g, '')
    .trim()
    .slice(0, maxLen);
  return cleaned === '' ? null : cleaned;
}

function sanitizeCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  if (n < 0 || n > 1e12) return null;
  return n;
}

function sanitizeNameList(value, maxItems = 64, maxLen = 64) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    const s = sanitizeRuntimeField(v, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function sanitizeInspectionSummary(body) {
  const b = body && typeof body === 'object' ? body : {};
  const summary = { exists: b.exists === true };
  if (!summary.exists) return summary;

  const cls = sanitizeRuntimeField(b.class);
  if (cls) summary.class = cls;

  const nCells = sanitizeCount(b.n_cells);
  if (nCells !== null) summary.nCells = nCells;
  const nFeatures = sanitizeCount(b.n_features);
  if (nFeatures !== null) summary.nFeatures = nFeatures;

  const assays = sanitizeNameList(b.assays);
  if (assays.length) summary.assays = assays;
  const reductions = sanitizeNameList(b.reductions);
  if (reductions.length) summary.reductions = reductions;

  const nMeta = sanitizeCount(b.n_meta_fields);
  if (nMeta !== null) summary.nMetaFields = nMeta;
  const metaFields = sanitizeNameList(b.meta_fields);
  if (metaFields.length) summary.metaFields = metaFields;

  const sv = sanitizeRuntimeField(b.seurat_version);
  if (sv) summary.seuratVersion = sv;
  const rv = sanitizeRuntimeField(b.r_version);
  if (rv) summary.rVersion = rv;

  return summary;
}

function sanitizeChecksum(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

function sanitizePipelineSummary(body) {
  const b = body && typeof body === 'object' ? body : {};
  const s = b.summary && typeof b.summary === 'object' ? b.summary : {};
  const out = {};

  const nCells = sanitizeCount(s.n_cells);
  if (nCells !== null) out.nCells = nCells;
  const nFeatures = sanitizeCount(s.n_features);
  if (nFeatures !== null) out.nFeatures = nFeatures;
  const preFilterCells = sanitizeCount(s.pre_filter_cells);
  if (preFilterCells !== null) out.preFilterCells = preFilterCells;
  const postFilterCells = sanitizeCount(s.post_filter_cells);
  if (postFilterCells !== null) out.postFilterCells = postFilterCells;
  if (typeof s.percent_mt_available === 'boolean') out.percentMtAvailable = s.percent_mt_available;
  const nVar = sanitizeCount(s.n_variable_features);
  if (nVar !== null) out.nVariableFeatures = nVar;
  const nPcs = sanitizeCount(s.n_pcs);
  if (nPcs !== null) out.nPcs = nPcs;
  const nClusters = sanitizeCount(s.n_clusters);
  if (nClusters !== null) out.nClusters = nClusters;
  const nSamples = sanitizeCount(s.n_samples);
  if (nSamples !== null) out.nSamples = nSamples;
  const conditions = sanitizeNameList(s.conditions, 48, 80);
  if (conditions.length) out.conditions = conditions;
  if (Array.isArray(s.samples_per_condition)) {
    const counts = [];
    for (const row of s.samples_per_condition) {
      if (!row || typeof row !== 'object') continue;
      const condition = sanitizeRuntimeField(row.condition, 80);
      const n = sanitizeCount(row.n);
      if (condition && n !== null) counts.push({ condition, n });
      if (counts.length >= 48) break;
    }
    if (counts.length) out.samplesPerCondition = counts;
  }

  const reductions = sanitizeNameList(s.reductions);
  if (reductions.length) out.reductions = reductions;
  const assays = sanitizeNameList(s.assays);
  if (assays.length) out.assays = assays;

  // Cluster sizes: a bounded list of non-negative counts (never per-cell data).
  if (Array.isArray(s.cluster_sizes)) {
    const sizes = [];
    for (const v of s.cluster_sizes) {
      const n = sanitizeCount(v);
      if (n !== null) sizes.push(n);
      if (sizes.length >= 256) break;
    }
    if (sizes.length) out.clusterSizes = sizes;
  }

  const method = sanitizeRuntimeField(s.normalization_method);
  if (method) out.normalizationMethod = method;
  const res =
    typeof s.resolution === 'number' && Number.isFinite(s.resolution) ? s.resolution : null;
  if (res !== null) out.resolution = res;

  const sv = sanitizeRuntimeField(b.seurat_version || (b.versions && b.versions.seurat_version));
  if (sv) out.seuratVersion = sv;
  const rv = sanitizeRuntimeField(b.r_version || (b.versions && b.versions.r_version));
  if (rv) out.rVersion = rv;

  const usedSeed = sanitizeCount(s.used_seed);
  if (usedSeed !== null) out.usedSeed = usedSeed;

  return out;
}

function sanitizeCheckpointInfo(body) {
  const b = body && typeof body === 'object' ? body : {};
  const c = b.checkpoint && typeof b.checkpoint === 'object' ? b.checkpoint : {};
  return {
    saved: c.saved === true,
    checksumSha256: sanitizeChecksum(c.checksum_sha256),
    sizeBytes: sanitizeCount(c.size_bytes),
  };
}

function sanitizeLoadSummary(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = { loaded: b.loaded === true };
  // Whether R re-verified the checkpoint file checksum before deserializing.
  out.checksumVerified = b.checksum_verified === true;
  if (!out.loaded) return out;

  const runtimeInstanceId = sanitizeRuntimeField(b.runtime_instance_id);
  if (runtimeInstanceId) {
    out.runtimeInstanceHash = crypto.createHash('sha256').update(runtimeInstanceId).digest('hex');
  }

  const cls = sanitizeRuntimeField(b.class);
  if (cls) out.class = cls;

  const nCells = sanitizeCount(b.n_cells);
  if (nCells !== null) out.nCells = nCells;
  const nFeatures = sanitizeCount(b.n_features);
  if (nFeatures !== null) out.nFeatures = nFeatures;

  const assays = sanitizeNameList(b.assays);
  if (assays.length) out.assays = assays;
  const reductions = sanitizeNameList(b.reductions);
  if (reductions.length) out.reductions = reductions;

  const nMeta = sanitizeCount(b.n_meta_fields);
  if (nMeta !== null) out.nMetaFields = nMeta;
  const metaFields = sanitizeNameList(b.meta_fields);
  if (metaFields.length) out.metaFields = metaFields;

  const sv = sanitizeRuntimeField(b.seurat_version);
  if (sv) out.seuratVersion = sv;
  const rv = sanitizeRuntimeField(b.r_version);
  if (rv) out.rVersion = rv;

  return out;
}

function sanitizeStatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (Math.abs(value) > 1e12) return null;
  if (value === 0) return 0;
  return Number(value.toPrecision(6));
}

function sanitizeDegSummary(body) {
  const b = body && typeof body === 'object' ? body : {};
  const s = b.summary && typeof b.summary === 'object' ? b.summary : {};
  const out = {};

  const groupBy = sanitizeRuntimeField(s.group_by);
  if (groupBy) out.groupBy = groupBy;
  const testUse = sanitizeRuntimeField(s.test_use);
  if (testUse) out.testUse = testUse;
  const assay = sanitizeRuntimeField(s.assay);
  if (assay) out.assay = assay;

  const nGroups = sanitizeCount(s.n_groups);
  if (nGroups !== null) out.nGroups = nGroups;
  // Group LABELS only (e.g. cluster ids) — bounded list of short safe strings.
  const groups = sanitizeNameList(s.groups, 256);
  if (groups.length) out.groups = groups;

  const nMarkersTotal = sanitizeCount(s.n_markers_total);
  if (nMarkersTotal !== null) out.nMarkersTotal = nMarkersTotal;

  // Per-group marker counts: a bounded list of { group, n } (never per-cell data).
  if (Array.isArray(s.markers_per_group)) {
    const perGroup = [];
    for (const row of s.markers_per_group) {
      if (!row || typeof row !== 'object') continue;
      const g = sanitizeRuntimeField(row.group);
      const n = sanitizeCount(row.n);
      if (g !== null && n !== null) perGroup.push({ group: g, n });
      if (perGroup.length >= 256) break;
    }
    if (perGroup.length) out.markersPerGroup = perGroup;
  }

  // Top-N markers per group: SAFE columns only, doubly bounded (per-row sanitize + a hard
  // overall row cap). group/gene are name-safe strings; the rest are bounded numbers.
  if (Array.isArray(s.top_markers)) {
    const rows = [];
    // Must match R completion_receipt_safe_value() so normal publication and
    // receipt recovery persist the exact same bounded scientific summary.
    const MAX_TOP_ROWS = 256;
    for (const r of s.top_markers) {
      if (!r || typeof r !== 'object') continue;
      const group = sanitizeRuntimeField(r.group);
      const gene = sanitizeRuntimeField(r.gene);
      if (group === null || gene === null) continue;
      const safeRow = { group, gene };
      const avg = sanitizeStatNumber(r.avg_log2FC);
      if (avg !== null) safeRow.avgLog2FC = avg;
      const p1 = sanitizeStatNumber(r.pct_1);
      if (p1 !== null) safeRow.pct1 = p1;
      const p2 = sanitizeStatNumber(r.pct_2);
      if (p2 !== null) safeRow.pct2 = p2;
      const padj = sanitizeStatNumber(r.p_val_adj);
      if (padj !== null) safeRow.pValAdj = padj;
      const rank = sanitizeCount(r.rank);
      if (rank !== null) safeRow.rank = rank;
      rows.push(safeRow);
      if (rows.length >= MAX_TOP_ROWS) break;
    }
    if (rows.length) out.topMarkers = rows;
  }

  const sv = sanitizeRuntimeField(b.seurat_version || (b.versions && b.versions.seurat_version));
  if (sv) out.seuratVersion = sv;
  const rv = sanitizeRuntimeField(b.r_version || (b.versions && b.versions.r_version));
  if (rv) out.rVersion = rv;

  return out;
}

function sanitizeDegResultInfo(body) {
  const b = body && typeof body === 'object' ? body : {};
  const r = b.result && typeof b.result === 'object' ? b.result : {};
  return {
    saved: r.saved === true,
    checksumSha256: sanitizeChecksum(r.checksum_sha256),
    sizeBytes: sanitizeCount(r.size_bytes),
    nRows: sanitizeCount(r.n_rows),
  };
}

function sanitizeExplorationSummary(body) {
  const source = body && typeof body === 'object' ? body : {};
  const recipe = sanitizeRuntimeField(source.recipe, 64);
  const out = {
    recipe: ['overview', 'feature_by_group', 'metadata_distribution'].includes(recipe)
      ? recipe
      : 'overview',
    panels: [],
  };
  const nCells = sanitizeCount(source.n_cells);
  const nFeatures = sanitizeCount(source.n_features);
  if (nCells !== null) out.nCells = nCells;
  if (nFeatures !== null) out.nFeatures = nFeatures;
  out.metadataFields = sanitizeNameList(source.metadata_fields, 128, 128);

  const panels = Array.isArray(source.panels) ? source.panels : [];
  for (const panel of panels.slice(0, 24)) {
    if (!panel || typeof panel !== 'object') continue;
    const type = sanitizeRuntimeField(panel.type, 32);
    if (!['histogram', 'bar', 'feature_group'].includes(type)) continue;
    const safe = {
      type,
      title: sanitizeRuntimeField(panel.title, 160) || 'Exploratory summary',
      rows: [],
    };
    const field = sanitizeRuntimeField(panel.field, 128);
    if (field) safe.field = field;
    const rows = Array.isArray(panel.rows) ? panel.rows : [];
    for (const row of rows.slice(0, 512)) {
      if (!row || typeof row !== 'object') continue;
      const clean = {};
      for (const key of ['label', 'feature', 'group']) {
        const value = sanitizeRuntimeField(row[key], 128);
        if (value) clean[key] = value;
      }
      for (const key of [
        'start',
        'end',
        'count',
        'average',
        'pct_detected',
        'q25',
        'median',
        'q75',
      ]) {
        const value = sanitizeStatNumber(row[key]);
        if (value !== null) clean[key === 'pct_detected' ? 'pctDetected' : key] = value;
      }
      if (Object.keys(clean).length > 0) safe.rows.push(clean);
    }
    if (safe.rows.length > 0) out.panels.push(safe);
  }
  return out;
}

function sanitizeEnrichmentSummary(body) {
  const b = body && typeof body === 'object' ? body : {};
  const s = b.summary && typeof b.summary === 'object' ? b.summary : {};
  const out = {};

  for (const [source, target] of [
    ['method', 'method'],
    ['group_by', 'groupBy'],
    ['assay', 'assay'],
    ['species', 'species'],
    ['gene_set_collection', 'geneSetCollection'],
    ['rank_metric', 'rankMetric'],
  ]) {
    const value = sanitizeRuntimeField(s[source], 80);
    if (value) out[target] = value;
  }

  if (s.comparison && typeof s.comparison === 'object') {
    const targetGroup = sanitizeRuntimeField(s.comparison.target_group, 80);
    const reference = sanitizeRuntimeField(s.comparison.reference, 80);
    if (targetGroup || reference) {
      out.comparison = {};
      if (targetGroup) out.comparison.targetGroup = targetGroup;
      if (reference) out.comparison.reference = reference;
    }
  }

  for (const [source, target] of [
    ['input_gene_count', 'inputGeneCount'],
    ['mapped_gene_count', 'mappedGeneCount'],
    ['tested_pathway_count', 'testedPathwayCount'],
    ['significant_pathway_count', 'significantPathwayCount'],
  ]) {
    const value = sanitizeCount(s[source]);
    if (value !== null) out[target] = value;
  }
  const mappingRate = sanitizeStatNumber(s.mapping_rate);
  if (mappingRate !== null && mappingRate >= 0 && mappingRate <= 1) {
    out.mappingRate = mappingRate;
  }

  if (s.package_versions && typeof s.package_versions === 'object') {
    const versions = {};
    for (const [source, target] of [
      ['r', 'r'],
      ['seurat', 'seurat'],
      ['annotation_dbi', 'annotationDbi'],
      ['go_db', 'goDb'],
      ['cluster_profiler', 'clusterProfiler'],
      ['fgsea', 'fgsea'],
      ['organism_db', 'organismDb'],
    ]) {
      const value = sanitizeRuntimeField(s.package_versions[source], 64);
      if (value) versions[target] = value;
    }
    if (Object.keys(versions).length) out.packageVersions = versions;
  }

  if (Array.isArray(s.top_pathways)) {
    const rows = [];
    for (const row of s.top_pathways) {
      if (!row || typeof row !== 'object') continue;
      const id = sanitizeRuntimeField(row.pathway_id, 80);
      const rawName = typeof row.pathway_name === 'string' ? row.pathway_name : '';
      const pathLikeName = /(?:[A-Za-z]:[\\/]|[\\/]|https?:|file:)/i.test(rawName);
      const name = pathLikeName ? null : sanitizeRuntimeField(rawName, 160);
      if (!id || !name) continue;
      const safe = { id, name };
      const nes = sanitizeStatNumber(row.normalized_enrichment_score);
      const pValue = sanitizeStatNumber(row.p_value);
      const adjustedPValue = sanitizeStatNumber(row.adjusted_p_value);
      const setSize = sanitizeCount(row.set_size);
      if (nes !== null) safe.normalizedEnrichmentScore = nes;
      if (pValue !== null && pValue >= 0 && pValue <= 1) safe.pValue = pValue;
      if (adjustedPValue !== null && adjustedPValue >= 0 && adjustedPValue <= 1) {
        safe.adjustedPValue = adjustedPValue;
      }
      if (setSize !== null) safe.setSize = setSize;
      if (typeof row.significant === 'boolean') safe.significant = row.significant;
      const direction = sanitizeRuntimeField(row.direction, 16);
      if (direction === 'positive' || direction === 'negative' || direction === 'neutral') {
        safe.direction = direction;
      }
      rows.push(safe);
      if (rows.length >= 25) break;
    }
    if (rows.length) out.topPathways = rows;
  }
  out.warnings = sanitizeNameList(s.warnings, 32, 160);
  return out;
}

function sanitizeEnrichmentResultInfo(body) {
  const result = sanitizeDegResultInfo(body);
  if (result.sizeBytes !== null && result.sizeBytes > 50 * 1024 * 1024) {
    result.saved = false;
  }
  if (result.nRows !== null && result.nRows > 100000) result.saved = false;
  return result;
}

function sanitizeConditionComparisonSummary(body) {
  const source =
    body && typeof body === 'object' && body.summary && typeof body.summary === 'object'
      ? body.summary
      : {};
  const top = Array.isArray(source.top_results) ? source.top_results.slice(0, 50) : [];
  return {
    method: sanitizeRuntimeField(source.method, 40),
    cellTypeColumn: sanitizeRuntimeField(source.cell_type_column, 64),
    unitOfReplication: sanitizeRuntimeField(source.unit_of_replication, 20),
    paired: source.paired === true,
    modelFormula: ['~ condition', '~ donor + condition'].includes(source.model_formula)
      ? source.model_formula
      : null,
    sampleCount: sanitizeCount(source.sample_count, 1000),
    testedCellTypeCount: sanitizeCount(source.tested_cell_type_count, 1000),
    testedGeneCount: sanitizeCount(source.tested_gene_count, 100000),
    significantResultCount: sanitizeCount(source.significant_result_count, 500000),
    skippedCellTypes: sanitizeNameList(source.skipped_cell_types, 128, 100),
    warnings: sanitizeNameList(source.warnings, 32, 160),
    packageVersions: {
      r: sanitizeRuntimeField(source.package_versions && source.package_versions.r, 40),
      seurat: sanitizeRuntimeField(source.package_versions && source.package_versions.seurat, 40),
      edgeR: sanitizeRuntimeField(source.package_versions && source.package_versions.edger, 40),
      limma: sanitizeRuntimeField(source.package_versions && source.package_versions.limma, 40),
    },
    topResults: top
      .map((row) => ({
        cellType: sanitizeRuntimeField(row && row.cell_type, 100),
        gene: sanitizeRuntimeField(row && row.gene, 100),
        logFc: sanitizeStatNumber(row && row.log_fc),
        pValue: sanitizeStatNumber(row && row.p_value),
        fdr: sanitizeStatNumber(row && row.fdr),
      }))
      .filter((row) => row.cellType && row.gene),
  };
}

function sanitizeCellChatEnum(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

function sanitizeCellChatText(value, maxLen = 80) {
  // Unlike a generic runtime label, this content can appear in the public
  // CellChat preview. Reject path/URL-shaped source values outright rather than
  // merely stripping separators and retaining an accidental secret segment.
  if (typeof value === 'string' && /(?:[A-Za-z]:[\\/]|[\\/]|https?:|file:)/i.test(value)) {
    return null;
  }
  return sanitizeRuntimeField(value, maxLen);
}

function sanitizeCellChatGroup(value) {
  if (typeof value !== 'string') return null;
  const match = /^Group ([1-9]\d*)$/.exec(value);
  if (!match) return null;
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index > 32) return null;
  return `Group ${index}`;
}

function sanitizeCellChatProbability(value) {
  const n = sanitizeStatNumber(value);
  return n !== null && n >= 0 ? n : null;
}

function sanitizeCellChatPValue(value) {
  const n = sanitizeStatNumber(value);
  return n !== null && n >= 0 && n <= 1 ? n : null;
}

function sanitizeCellChatWarnings(value) {
  if (!Array.isArray(value)) return [];
  const warnings = [];
  for (const item of value) {
    const text = sanitizeCellChatText(item, 160);
    if (text) warnings.push(text);
    if (warnings.length >= 32) break;
  }
  return warnings;
}

function sanitizeCellChatSummary(body) {
  const b = body && typeof body === 'object' ? body : {};
  const s = b.summary && typeof b.summary === 'object' ? b.summary : {};
  const out = {};

  const method = sanitizeCellChatText(s.method, 80);
  if (method) out.method = method;
  const analysisIntent = sanitizeCellChatEnum(s.analysis_intent, ['single_context']);
  if (analysisIntent) out.analysisIntent = analysisIntent;
  const groupBy = sanitizeCellChatEnum(s.group_by, ['seurat_clusters', 'ident']);
  if (groupBy) out.groupBy = groupBy;
  const assay = sanitizeCellChatEnum(s.assay, ['RNA']);
  if (assay) out.assay = assay;
  const species = sanitizeCellChatEnum(s.species, ['human', 'mouse']);
  if (species) out.species = species;
  const databaseCategory = sanitizeCellChatEnum(s.database_category, [
    'all',
    'secreted_signaling',
    'ecm_receptor',
    'cell_cell_contact',
  ]);
  if (databaseCategory) out.databaseCategory = databaseCategory;
  const pValueCutoff = sanitizeCellChatPValue(s.p_value_cutoff);
  if (pValueCutoff !== null && pValueCutoff >= 0.000001 && pValueCutoff <= 0.1) {
    out.pValueCutoff = pValueCutoff;
  }

  for (const [source, target] of [
    ['input_cell_count', 'inputCellCount'],
    ['analyzed_cell_count', 'analyzedCellCount'],
    ['input_group_count', 'inputGroupCount'],
    ['analyzed_group_count', 'analyzedGroupCount'],
    ['excluded_group_count', 'excludedGroupCount'],
    ['candidate_interaction_count', 'candidateInteractionCount'],
    ['retained_interaction_count', 'retainedInteractionCount'],
    ['retained_pathway_count', 'retainedPathwayCount'],
  ]) {
    const value = sanitizeCount(s[source]);
    if (value !== null) out[target] = value;
  }

  const groups = [];
  if (Array.isArray(s.groups)) {
    for (const row of s.groups) {
      if (!row || typeof row !== 'object') continue;
      const group = sanitizeCellChatGroup(row.group);
      const inputCells = sanitizeCount(row.input_cells);
      const analyzedCells = sanitizeCount(row.analyzed_cells);
      if (group && inputCells !== null && analyzedCells !== null && analyzedCells <= inputCells) {
        groups.push({ group, inputCells, analyzedCells });
      }
      if (groups.length >= 64) break;
    }
  }
  out.groups = groups;

  const excludedGroups = [];
  if (Array.isArray(s.excluded_groups)) {
    for (const row of s.excluded_groups) {
      if (!row || typeof row !== 'object') continue;
      const group = sanitizeCellChatGroup(row.group);
      const inputCells = sanitizeCount(row.input_cells);
      const reason = sanitizeCellChatText(row.reason, 80);
      if (group && inputCells !== null && reason)
        excludedGroups.push({ group, inputCells, reason });
      if (excludedGroups.length >= 64) break;
    }
  }
  out.excludedGroups = excludedGroups;

  const versions = {};
  if (s.package_versions && typeof s.package_versions === 'object') {
    for (const key of ['r', 'seurat', 'cellchat', 'cellchat_db']) {
      const value = sanitizeCellChatText(s.package_versions[key], 80);
      if (value) versions[key === 'cellchat_db' ? 'cellchatDb' : key] = value;
    }
  }
  out.packageVersions = versions;

  const topInteractions = [];
  if (Array.isArray(s.top_interactions)) {
    for (const row of s.top_interactions) {
      if (!row || typeof row !== 'object') continue;
      const source = sanitizeCellChatGroup(row.source);
      const target = sanitizeCellChatGroup(row.target);
      const interaction = sanitizeCellChatText(row.interaction, 160);
      const pathway = sanitizeCellChatText(row.pathway, 160);
      const probability = sanitizeCellChatProbability(row.probability);
      const pValue = sanitizeCellChatPValue(row.p_value);
      const category = sanitizeCellChatEnum(row.category, [
        'all',
        'secreted_signaling',
        'ecm_receptor',
        'cell_cell_contact',
      ]);
      if (
        source &&
        target &&
        interaction &&
        pathway &&
        probability !== null &&
        pValue !== null &&
        pValue <= pValueCutoff &&
        category
      ) {
        topInteractions.push({
          source,
          target,
          interaction,
          pathway,
          probability,
          pValue,
          category,
        });
      }
      if (topInteractions.length >= 100) break;
    }
  }
  out.topInteractions = topInteractions;

  const topPathways = [];
  if (Array.isArray(s.top_pathways)) {
    for (const row of s.top_pathways) {
      if (!row || typeof row !== 'object') continue;
      const source = sanitizeCellChatGroup(row.source);
      const target = sanitizeCellChatGroup(row.target);
      const pathway = sanitizeCellChatText(row.pathway, 160);
      const probability = sanitizeCellChatProbability(row.probability);
      const pValue = sanitizeCellChatPValue(row.p_value);
      if (
        source &&
        target &&
        pathway &&
        probability !== null &&
        pValue !== null &&
        pValue <= pValueCutoff
      ) {
        topPathways.push({ source, target, pathway, probability, pValue });
      }
      if (topPathways.length >= 100) break;
    }
  }
  out.topPathways = topPathways;
  out.warnings = sanitizeCellChatWarnings(s.warnings);
  return out;
}

function isCompleteCellChatSummary(summary) {
  if (!summary || typeof summary !== 'object') return false;
  const scalarKeys = [
    'method',
    'analysisIntent',
    'groupBy',
    'assay',
    'species',
    'databaseCategory',
    'pValueCutoff',
    'inputCellCount',
    'analyzedCellCount',
    'inputGroupCount',
    'analyzedGroupCount',
    'excludedGroupCount',
    'candidateInteractionCount',
    'retainedInteractionCount',
    'retainedPathwayCount',
  ];
  if (scalarKeys.some((key) => !Object.prototype.hasOwnProperty.call(summary, key))) return false;
  if (
    !Array.isArray(summary.groups) ||
    !Array.isArray(summary.excludedGroups) ||
    !Array.isArray(summary.topInteractions) ||
    !Array.isArray(summary.topPathways) ||
    !Array.isArray(summary.warnings) ||
    !summary.packageVersions ||
    typeof summary.packageVersions !== 'object'
  )
    return false;
  if (
    summary.inputCellCount < summary.analyzedCellCount ||
    summary.inputGroupCount < summary.analyzedGroupCount ||
    summary.excludedGroupCount !== summary.excludedGroups.length ||
    summary.analyzedGroupCount !== summary.groups.length ||
    summary.inputGroupCount !== summary.analyzedGroupCount + summary.excludedGroupCount ||
    summary.inputGroupCount < 2 ||
    summary.inputGroupCount > 32 ||
    summary.analyzedGroupCount < 2 ||
    summary.analyzedGroupCount > 32 ||
    summary.candidateInteractionCount < summary.retainedInteractionCount ||
    summary.retainedInteractionCount > MAX_CELLCHAT_RESULT_ROWS ||
    !summary.groups.every((row) => sanitizeCellChatGroup(row.group) === row.group) ||
    !summary.excludedGroups.every((row) => sanitizeCellChatGroup(row.group) === row.group) ||
    !summary.topInteractions.every(
      (row) =>
        sanitizeCellChatGroup(row.source) === row.source &&
        sanitizeCellChatGroup(row.target) === row.target &&
        row.pValue <= summary.pValueCutoff
    ) ||
    !summary.topPathways.every(
      (row) =>
        sanitizeCellChatGroup(row.source) === row.source &&
        sanitizeCellChatGroup(row.target) === row.target &&
        row.pValue <= summary.pValueCutoff
    ) ||
    (summary.retainedInteractionCount > 0 && summary.topInteractions.length === 0) ||
    (summary.retainedPathwayCount > 0 && summary.topPathways.length === 0)
  )
    return false;
  // A pathway-level aggregation can legitimately contain more retained
  // source/target rows than the interaction-level table after CellChat's
  // respective filters. It is therefore not a safe invariant to compare
  // `retainedPathwayCount` with `candidateInteractionCount` here.
  return ['r', 'seurat', 'cellchat', 'cellchatDb'].every(
    (key) => typeof summary.packageVersions[key] === 'string'
  );
}

function sanitizeCellChatResultInfo(body) {
  const result = sanitizeDegResultInfo(body);
  if (result.sizeBytes !== null && result.sizeBytes > 50 * 1024 * 1024) result.saved = false;
  if (result.nRows !== null && result.nRows > MAX_CELLCHAT_RESULT_ROWS) result.saved = false;
  return result;
}

module.exports = {
  sanitizeRuntimeField,
  sanitizeCount,
  sanitizeNameList,
  sanitizeInspectionSummary,
  sanitizeChecksum,
  sanitizePipelineSummary,
  sanitizeCheckpointInfo,
  sanitizeLoadSummary,
  sanitizeStatNumber,
  sanitizeDegSummary,
  sanitizeDegResultInfo,
  sanitizeExplorationSummary,
  sanitizeEnrichmentSummary,
  sanitizeEnrichmentResultInfo,
  sanitizeConditionComparisonSummary,
  sanitizeCellChatGroup,
  sanitizeCellChatSummary,
  isCompleteCellChatSummary,
  sanitizeCellChatResultInfo,
};
