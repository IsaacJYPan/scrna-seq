import { describe, expect, it } from 'vitest';
import { findRecordedSampleDesign, planIsEmpty, planRecordedSampleImport } from './studyDesignImport';

const prepared = {
  id: 'ao_prepared',
  metadata: {
    sampleMetadataColumn: 'sample_id',
    sampleDesign: [
      { sampleName: 'd1', conditionName: 'ctrl', donorCode: 'D1', batch: null },
      { sampleName: 'd2', conditionName: 'ctrl', donorCode: 'D2' },
      { sampleName: 'd3', conditionName: 'stim', donorCode: 'D3' },
    ],
  },
};
const saved = { id: 'ao_saved', parentObjId: 'ao_prepared', metadata: { source: 'checkpoint.save.v1' } };

describe('findRecordedSampleDesign', () => {
  it('walks from a saved version to the prepared analysis sample sheet', () => {
    const recorded = findRecordedSampleDesign([saved, prepared], 'ao_saved');
    expect(recorded.sourceObjectId).toBe('ao_prepared');
    expect(recorded.sampleColumn).toBe('sample_id');
    expect(recorded.samples[0]).toEqual({ name: 'd1', conditionName: 'ctrl', donorCode: 'D1', batch: '' });
  });

  it('returns null without a recorded design and survives lineage cycles', () => {
    expect(findRecordedSampleDesign([{ id: 'a', parentObjId: 'b' }, { id: 'b', parentObjId: 'a' }], 'a')).toBeNull();
    expect(findRecordedSampleDesign([], 'missing')).toBeNull();
  });
});

describe('planRecordedSampleImport', () => {
  const recorded = findRecordedSampleDesign([saved, prepared], 'ao_saved');

  it('plans everything for an empty study design', () => {
    const plan = planRecordedSampleImport({ recorded });
    expect(plan.conditionsToCreate).toEqual(['ctrl', 'stim']);
    expect(plan.samplesToCreate.map(row => row.name)).toEqual(['d1', 'd2', 'd3']);
    expect(plan.bindingsToCreate).toEqual([
      { sampleName: 'd1', cellMetadataColumn: 'sample_id', cellMetadataValue: 'd1' },
      { sampleName: 'd2', cellMetadataColumn: 'sample_id', cellMetadataValue: 'd2' },
      { sampleName: 'd3', cellMetadataColumn: 'sample_id', cellMetadataValue: 'd3' },
    ]);
  });

  it('reuses existing records, skips bound samples, and reports condition conflicts', () => {
    const plan = planRecordedSampleImport({
      recorded,
      conditions: [{ id: 'c1', name: 'CTRL' }, { id: 'c2', name: 'other' }],
      samples: [{ id: 's1', name: 'd1', conditionId: 'c1' }, { id: 's3', name: 'D3', conditionId: 'c2' }],
      bindings: [{ sampleId: 's1', cellMetadataColumn: 'sample_id', cellMetadataValue: 'd1' }],
    });
    expect(plan.conditionsToCreate).toEqual(['stim']);
    expect(plan.samplesToCreate.map(row => row.name)).toEqual(['d2']);
    expect(plan.bindingsToCreate.map(row => row.sampleName)).toEqual(['d2']);
    expect(plan.conflicts).toEqual(['d3 is already registered under condition other.']);
  });

  it('is empty once everything is registered and mapped', () => {
    const plan = planRecordedSampleImport({
      recorded,
      conditions: [{ id: 'c1', name: 'ctrl' }, { id: 'c2', name: 'stim' }],
      samples: ['d1', 'd2', 'd3'].map((name, i) => ({ id: `s${i}`, name, conditionId: i < 2 ? 'c1' : 'c2' })),
      bindings: ['s0', 's1', 's2'].map(sampleId => ({ sampleId })),
    });
    expect(planIsEmpty(plan)).toBe(true);
  });
});
