import { describe, expect, it } from 'vitest';
import { runInputLabel } from './SeuratPipelinePanel';

const sample = (sampleName, conditionName) => ({ datasetId: `ds_${sampleName}`, sampleName, conditionName });

describe('runInputLabel', () => {
  it('describes a recorded multi-sample run by its samples and conditions, not its first file', () => {
    const job = { parameters: { samples: [sample('C51', 'healthy'), sample('C141', 'mild'), sample('C143', 'Severe'), sample('C145', 'severe')] } };
    const result = runInputLabel({ job, multiSampleMode: true, activeDataset: { originalFilename: 'GSM4339769_C141.h5' } });
    expect(result).toEqual({ label: 'Input', value: '4 samples across 3 conditions' });
  });

  it('uses the sample sheet before the run records its samples', () => {
    const result = runInputLabel({ job: { parameters: {} }, multiSampleMode: true, multiSampleRows: [sample('A', 'x'), sample('B', '')] });
    expect(result).toEqual({ label: 'Input', value: '2 samples across 1 condition' });
  });

  it('keeps the file name for a single-dataset run', () => {
    const result = runInputLabel({ job: { parameters: {} }, multiSampleMode: false, activeDataset: { originalFilename: 'pbmc3k.h5' } });
    expect(result).toEqual({ label: 'Dataset', value: 'pbmc3k.h5' });
    expect(runInputLabel({ job: null, multiSampleMode: false }).value).toBe('Selected dataset');
  });
});
