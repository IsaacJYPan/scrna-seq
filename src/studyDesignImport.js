// Reuse the sample sheet a researcher already entered for the multi-condition
// preparation (stored as `sampleDesign` on the prepared analysis) instead of
// asking them to retype every condition, sample, donor and mapping.

const MAX_LINEAGE_STEPS = 64;

function key(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en-US');
}

function text(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed || '';
}

// Walk from the selected saved version up through its recorded parents until
// an analysis that carries the original sample sheet is found.
export function findRecordedSampleDesign(objects, objectId) {
  const byId = new Map((Array.isArray(objects) ? objects : []).map(object => [object?.id, object]));
  const seen = new Set();
  let current = byId.get(objectId);
  for (let step = 0; current && step < MAX_LINEAGE_STEPS && !seen.has(current.id); step += 1) {
    seen.add(current.id);
    const metadata = current.metadata && typeof current.metadata === 'object' ? current.metadata : {};
    const design = Array.isArray(metadata.sampleDesign) ? metadata.sampleDesign : null;
    if (design && design.length) {
      const samples = design
        .map(row => ({
          name: text(row?.sampleName),
          conditionName: text(row?.conditionName),
          donorCode: text(row?.donorCode),
          batch: text(row?.batch),
        }))
        .filter(row => row.name && row.conditionName);
      if (samples.length) {
        return {
          sourceObjectId: current.id,
          sampleColumn: text(metadata.sampleMetadataColumn) || 'sample_id',
          samples,
        };
      }
    }
    current = byId.get(current.parentObjId || current.parentObjectId);
  }
  return null;
}

// Decide what is missing. Existing records are matched by name (case-insensitive)
// and never modified; a same-named sample with a different condition is
// reported as a conflict instead of being silently reused.
export function planRecordedSampleImport({ recorded, conditions = [], samples = [], bindings = [] }) {
  const plan = { conditionsToCreate: [], samplesToCreate: [], bindingsToCreate: [], conflicts: [] };
  if (!recorded) return plan;
  const conditionsByName = new Map(conditions.map(condition => [key(condition.name), condition]));
  const conditionNameById = new Map(conditions.map(condition => [condition.id, condition.name]));
  const samplesByName = new Map(samples.map(sample => [key(sample.name), sample]));
  const boundSampleIds = new Set(bindings.map(binding => binding.sampleId || binding.biologicalSampleId).filter(Boolean));
  const boundValues = new Set(bindings.map(binding => `${binding.cellMetadataColumn}\u0000${binding.cellMetadataValue}`));

  for (const row of recorded.samples) {
    if (!conditionsByName.has(key(row.conditionName))
        && !plan.conditionsToCreate.some(name => key(name) === key(row.conditionName))) {
      plan.conditionsToCreate.push(row.conditionName);
    }
    const existing = samplesByName.get(key(row.name));
    if (existing) {
      const existingCondition = conditionNameById.get(existing.conditionId) || existing.conditionName;
      if (existingCondition && key(existingCondition) !== key(row.conditionName)) {
        plan.conflicts.push(`${row.name} is already registered under condition ${existingCondition}.`);
        continue;
      }
    } else {
      plan.samplesToCreate.push(row);
    }
    const alreadyBound = (existing && boundSampleIds.has(existing.id))
      || boundValues.has(`${recorded.sampleColumn}\u0000${row.name}`);
    if (!alreadyBound) {
      plan.bindingsToCreate.push({ sampleName: row.name, cellMetadataColumn: recorded.sampleColumn, cellMetadataValue: row.name });
    }
  }
  return plan;
}

export function planIsEmpty(plan) {
  return !plan.conditionsToCreate.length && !plan.samplesToCreate.length && !plan.bindingsToCreate.length;
}
