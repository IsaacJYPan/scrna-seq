'use strict';

const db = require('./pgDatabase');

const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const WRITE_ROLES = ['owner', 'admin', 'analyst'];
const MODALITIES = new Set(['scrna', 'spatial']);
const REPLICATION_UNITS = new Set(['sample', 'donor']);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeText(value, field, maxLength, { required = false } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  const invalidControl = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if ((required && !text) || text.length > maxLength || invalidControl) {
    throw codedError('INVALID_EXPERIMENTAL_DESIGN', `${field} is invalid.`);
  }
  return text || null;
}

function safeMetadata(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw codedError('INVALID_EXPERIMENTAL_DESIGN', 'Sample metadata must be an object.');
  }
  const json = JSON.stringify(value);
  if (json.length > 10000) {
    throw codedError('INVALID_EXPERIMENTAL_DESIGN', 'Sample metadata is too large.');
  }
  return JSON.parse(json);
}

function safeDesignColumn(value, field, required = false) {
  const text = safeText(value, field, 64, { required });
  if (text && !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(text)) {
    throw codedError('INVALID_EXPERIMENTAL_DESIGN', `${field} must be a simple metadata column name.`);
  }
  return text;
}

function parseCovariates(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw codedError('INVALID_EXPERIMENTAL_DESIGN', 'Covariates must be an array of at most 8 metadata column names.');
  }
  const result = value.map((item) => safeDesignColumn(item, 'Covariate', true));
  if (new Set(result).size !== result.length) {
    throw codedError('INVALID_EXPERIMENTAL_DESIGN', 'Covariates must be unique.');
  }
  return result;
}

function conditionFromRow(row) {
  return row && {
    id: row.id, projectId: row.project_id, name: row.name,
    description: row.description || '', createdByUserId: Number(row.created_by_user_id),
    createdAt: row.created_at,
  };
}

function sampleFromRow(row) {
  return row && {
    id: row.id, projectId: row.project_id, datasetId: row.dataset_id,
    conditionId: row.condition_id, conditionName: row.condition_name || undefined,
    name: row.name, donorCode: row.donor_code, batch: row.batch,
    replicateLabel: row.replicate_label, modality: row.modality,
    organism: row.organism, tissue: row.tissue, platform: row.platform,
    metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json || {},
    createdByUserId: Number(row.created_by_user_id), createdAt: row.created_at,
  };
}

function bindingFromRow(row) {
  return row && {
    id: row.id, projectId: row.project_id, analysisObjectId: row.analysis_object_id,
    sampleId: row.sample_id, sampleName: row.sample_name || undefined,
    conditionId: row.condition_id || undefined, conditionName: row.condition_name || undefined,
    cellMetadataColumn: row.cell_metadata_column, cellMetadataValue: row.cell_metadata_value,
    createdByUserId: Number(row.created_by_user_id), createdAt: row.created_at,
  };
}

function contrastFromRow(row) {
  return row && {
    id: row.id, projectId: row.project_id, analysisObjectId: row.analysis_object_id,
    name: row.name, numeratorConditionId: row.numerator_condition_id,
    denominatorConditionId: row.denominator_condition_id,
    numeratorConditionName: row.numerator_condition_name || undefined,
    denominatorConditionName: row.denominator_condition_name || undefined,
    unitOfReplication: row.unit_of_replication, paired: row.paired,
    cellTypeColumn: row.cell_type_column,
    blockingFactor: row.blocking_factor,
    covariates: typeof row.covariates_json === 'string' ? JSON.parse(row.covariates_json) : row.covariates_json || [],
    status: row.status,
    validation: typeof row.validation_json === 'string' ? JSON.parse(row.validation_json) : row.validation_json || {},
    createdByUserId: Number(row.created_by_user_id), createdAt: row.created_at,
  };
}

function validateReplicates(samples, input) {
  const numerator = samples.filter((sample) => sample.condition_id === input.numeratorConditionId);
  const denominator = samples.filter((sample) => sample.condition_id === input.denominatorConditionId);
  const unit = input.unitOfReplication;
  const issues = [];
  const warnings = [];
  let numeratorUnits;
  let denominatorUnits;

  if (unit === 'donor') {
    if ([...numerator, ...denominator].some((sample) => !sample.donor_code)) {
      issues.push('Every bound sample requires a donor code for donor-level replication.');
    }
    numeratorUnits = new Set(numerator.map((sample) => sample.donor_code).filter(Boolean));
    denominatorUnits = new Set(denominator.map((sample) => sample.donor_code).filter(Boolean));
  } else {
    numeratorUnits = new Set(numerator.map((sample) => sample.id));
    denominatorUnits = new Set(denominator.map((sample) => sample.id));
  }

  if (numeratorUnits.size < 2 || denominatorUnits.size < 2) {
    issues.push('At least two independent replication units are required in each condition.');
  } else if (numeratorUnits.size < 3 || denominatorUnits.size < 3) {
    warnings.push('Only two replication units are present in at least one condition; three or more are recommended.');
  }

  if (input.paired) {
    if (unit !== 'donor') issues.push('Paired contrasts require donor-level replication.');
    const missingNumerator = [...denominatorUnits].filter((value) => !numeratorUnits.has(value));
    const missingDenominator = [...numeratorUnits].filter((value) => !denominatorUnits.has(value));
    if (missingNumerator.length || missingDenominator.length) {
      issues.push('Paired contrasts require the same donor codes in both conditions.');
    }
  } else if (unit === 'donor') {
    const overlap = [...numeratorUnits].filter((value) => denominatorUnits.has(value));
    if (overlap.length) {
      issues.push('Donors present in both conditions must use a paired design.');
    }
  }

  return {
    status: issues.length ? 'invalid' : warnings.length ? 'warning' : 'valid',
    issues, warnings,
    counts: {
      numeratorSamples: numerator.length, denominatorSamples: denominator.length,
      numeratorUnits: numeratorUnits.size, denominatorUnits: denominatorUnits.size,
    },
  };
}

async function createCondition(userId, projectId, input = {}) {
  const member = await db.requireProjectRole(userId, projectId, WRITE_ROLES);
  const name = safeText(input.name, 'Condition name', 100, { required: true });
  const description = safeText(input.description, 'Condition description', 1000) || '';
  try {
    const { rows } = await db.query(
      `INSERT INTO study_conditions (id, project_id, name, description, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [db.genId('cond'), String(projectId), name, description, Number(member.userId)]
    );
    return conditionFromRow(rows[0]);
  } catch (error) {
    if (error.code === '23505') throw codedError('EXPERIMENTAL_DESIGN_CONFLICT', 'A condition with this name already exists.');
    throw error;
  }
}

async function listConditions(userId, projectId) {
  await db.requireProjectRole(userId, projectId, READ_ROLES);
  const { rows } = await db.query(
    'SELECT * FROM study_conditions WHERE project_id = $1 ORDER BY lower(name), created_at',
    [String(projectId)]
  );
  return rows.map(conditionFromRow);
}

async function createSample(userId, projectId, input = {}) {
  const member = await db.requireProjectRole(userId, projectId, WRITE_ROLES);
  const name = safeText(input.name, 'Sample name', 120, { required: true });
  const conditionId = safeText(input.conditionId, 'Condition ID', 128, { required: true });
  const modality = safeText(input.modality || 'scrna', 'Modality', 20, { required: true });
  if (!MODALITIES.has(modality)) throw codedError('INVALID_EXPERIMENTAL_DESIGN', 'Modality must be scrna or spatial.');
  const condition = await db.query('SELECT id FROM study_conditions WHERE id = $1 AND project_id = $2', [conditionId, String(projectId)]);
  if (!condition.rows[0]) throw codedError('EXPERIMENTAL_DESIGN_NOT_FOUND', 'Condition not found.');
  const datasetId = input.datasetId == null ? null : safeText(input.datasetId, 'Dataset ID', 128, { required: true });
  if (datasetId) {
    const dataset = await db.query('SELECT id FROM datasets WHERE id = $1 AND project_id = $2', [datasetId, String(projectId)]);
    if (!dataset.rows[0]) throw codedError('EXPERIMENTAL_DESIGN_NOT_FOUND', 'Dataset not found.');
  }
  const values = [
    db.genId('sample'), String(projectId), datasetId, conditionId, name,
    safeText(input.donorCode, 'Donor code', 120), safeText(input.batch, 'Batch', 120),
    safeText(input.replicateLabel, 'Replicate label', 120), modality,
    safeText(input.organism, 'Organism', 120), safeText(input.tissue, 'Tissue', 120),
    safeText(input.platform, 'Platform', 120), JSON.stringify(safeMetadata(input.metadata)),
    Number(member.userId),
  ];
  try {
    const { rows } = await db.query(
      `INSERT INTO biological_samples
       (id, project_id, dataset_id, condition_id, name, donor_code, batch, replicate_label,
        modality, organism, tissue, platform, metadata_json, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, values
    );
    return sampleFromRow(rows[0]);
  } catch (error) {
    if (error.code === '23505') throw codedError('EXPERIMENTAL_DESIGN_CONFLICT', 'A sample with this name already exists.');
    throw error;
  }
}

async function listSamples(userId, projectId) {
  await db.requireProjectRole(userId, projectId, READ_ROLES);
  const { rows } = await db.query(
    `SELECT sample.*, condition.name AS condition_name FROM biological_samples sample
     JOIN study_conditions condition ON condition.id = sample.condition_id
     WHERE sample.project_id = $1 ORDER BY lower(sample.name), sample.created_at`,
    [String(projectId)]
  );
  return rows.map(sampleFromRow);
}

async function bindSample(userId, projectId, analysisObjectId, input = {}) {
  const member = await db.requireProjectRole(userId, projectId, WRITE_ROLES);
  const sampleId = safeText(input.sampleId, 'Sample ID', 128, { required: true });
  const column = safeDesignColumn(input.cellMetadataColumn, 'Cell metadata column', true);
  const value = safeText(input.cellMetadataValue, 'Cell metadata value', 200, { required: true });
  const [object, sample] = await Promise.all([
    db.query('SELECT id FROM analysis_objects WHERE id = $1 AND project_id = $2', [String(analysisObjectId), String(projectId)]),
    db.query('SELECT id FROM biological_samples WHERE id = $1 AND project_id = $2', [sampleId, String(projectId)]),
  ]);
  if (!object.rows[0] || !sample.rows[0]) throw codedError('EXPERIMENTAL_DESIGN_NOT_FOUND', 'Analysis object or sample not found.');
  try {
    const { rows } = await db.query(
      `INSERT INTO analysis_object_sample_bindings
       (id, project_id, analysis_object_id, sample_id, cell_metadata_column, cell_metadata_value, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [db.genId('bind'), String(projectId), String(analysisObjectId), sampleId, column, value, Number(member.userId)]
    );
    return bindingFromRow(rows[0]);
  } catch (error) {
    if (error.code === '23505') throw codedError('EXPERIMENTAL_DESIGN_CONFLICT', 'This sample or metadata value is already bound to the analysis object.');
    throw error;
  }
}

async function listBindings(userId, projectId, analysisObjectId) {
  await db.requireProjectRole(userId, projectId, READ_ROLES);
  const object = await db.query('SELECT id FROM analysis_objects WHERE id = $1 AND project_id = $2', [String(analysisObjectId), String(projectId)]);
  if (!object.rows[0]) throw codedError('EXPERIMENTAL_DESIGN_NOT_FOUND', 'Analysis object not found.');
  const { rows } = await db.query(
    `SELECT binding.*, sample.name AS sample_name, sample.condition_id, condition.name AS condition_name
     FROM analysis_object_sample_bindings binding
     JOIN biological_samples sample ON sample.id = binding.sample_id
     JOIN study_conditions condition ON condition.id = sample.condition_id
     WHERE binding.project_id = $1 AND binding.analysis_object_id = $2
     ORDER BY lower(sample.name)`, [String(projectId), String(analysisObjectId)]
  );
  return rows.map(bindingFromRow);
}

async function createContrast(userId, projectId, input = {}) {
  const member = await db.requireProjectRole(userId, projectId, WRITE_ROLES);
  const normalized = {
    name: safeText(input.name, 'Contrast name', 120, { required: true }),
    analysisObjectId: safeText(input.analysisObjectId, 'Analysis object ID', 128, { required: true }),
    numeratorConditionId: safeText(input.numeratorConditionId, 'Numerator condition ID', 128, { required: true }),
    denominatorConditionId: safeText(input.denominatorConditionId, 'Denominator condition ID', 128, { required: true }),
    unitOfReplication: safeText(input.unitOfReplication || 'sample', 'Unit of replication', 20, { required: true }),
    paired: input.paired === true,
    cellTypeColumn: safeDesignColumn(input.cellTypeColumn || 'seurat_clusters', 'Cell type column', true),
    blockingFactor: safeDesignColumn(input.blockingFactor, 'Blocking factor'),
    covariates: parseCovariates(input.covariates),
  };
  if (normalized.numeratorConditionId === normalized.denominatorConditionId) {
    throw codedError('INVALID_EXPERIMENTAL_DESIGN', 'Contrast conditions must be different.');
  }
  if (!REPLICATION_UNITS.has(normalized.unitOfReplication)) {
    throw codedError('INVALID_EXPERIMENTAL_DESIGN', 'Unit of replication must be sample or donor.');
  }
  const [object, conditions, bound] = await Promise.all([
    db.query('SELECT id FROM analysis_objects WHERE id = $1 AND project_id = $2', [normalized.analysisObjectId, String(projectId)]),
    db.query('SELECT id FROM study_conditions WHERE project_id = $1 AND id = ANY($2::text[])', [String(projectId), [normalized.numeratorConditionId, normalized.denominatorConditionId]]),
    db.query(
      `SELECT sample.id, sample.condition_id, sample.donor_code,
              binding.cell_metadata_column, binding.cell_metadata_value
       FROM analysis_object_sample_bindings binding
       JOIN biological_samples sample ON sample.id = binding.sample_id
       WHERE binding.project_id = $1 AND binding.analysis_object_id = $2
         AND sample.condition_id = ANY($3::text[])
       ORDER BY sample.id`,
      [String(projectId), normalized.analysisObjectId, [normalized.numeratorConditionId, normalized.denominatorConditionId]]
    ),
  ]);
  if (!object.rows[0] || conditions.rows.length !== 2) {
    throw codedError('EXPERIMENTAL_DESIGN_NOT_FOUND', 'Analysis object or condition not found.');
  }
  const validation = validateReplicates(bound.rows, normalized);
  const id = db.genId('contrast');
  const pool = await db.connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO condition_contrasts
       (id, project_id, analysis_object_id, name, numerator_condition_id,
        denominator_condition_id, unit_of_replication, paired, cell_type_column, blocking_factor,
        covariates_json, status, validation_json, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id, String(projectId), normalized.analysisObjectId, normalized.name,
        normalized.numeratorConditionId, normalized.denominatorConditionId,
        normalized.unitOfReplication, normalized.paired, normalized.cellTypeColumn, normalized.blockingFactor,
        JSON.stringify(normalized.covariates), validation.status, JSON.stringify(validation),
        Number(member.userId)]
    );
    for (const sample of bound.rows) {
      await client.query(
        `INSERT INTO condition_contrast_samples
         (contrast_id, sample_id, condition_id, donor_code, cell_metadata_column, cell_metadata_value)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, sample.id, sample.condition_id, sample.donor_code,
          sample.cell_metadata_column, sample.cell_metadata_value]
      );
    }
    await client.query('COMMIT');
    return contrastFromRow(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') throw codedError('EXPERIMENTAL_DESIGN_CONFLICT', 'A contrast with this name already exists.');
    throw error;
  } finally {
    client.release();
  }
}

async function listContrasts(userId, projectId) {
  await db.requireProjectRole(userId, projectId, READ_ROLES);
  const { rows } = await db.query(
    `SELECT contrast.*, numerator.name AS numerator_condition_name,
            denominator.name AS denominator_condition_name
     FROM condition_contrasts contrast
     JOIN study_conditions numerator ON numerator.id = contrast.numerator_condition_id
     JOIN study_conditions denominator ON denominator.id = contrast.denominator_condition_id
     WHERE contrast.project_id = $1 ORDER BY contrast.created_at DESC`, [String(projectId)]
  );
  return rows.map(contrastFromRow);
}

module.exports = {
  createCondition, listConditions, createSample, listSamples, bindSample,
  listBindings, createContrast, listContrasts, validateReplicates,
  conditionFromRow, sampleFromRow, bindingFromRow, contrastFromRow,
};
