import { describe, it, expect } from 'vitest';
import {
  PIPELINE_CONTRACT,
  getDefaultPipelineManifest as getFrontendDefault,
  resolvePipelineManifest,
  validatePipelineManifest as validateFrontend,
} from '../src/pipelines/pipelineRegistry.js';

const {
  getDefaultPipelineManifest: getBackendDefault,
  validatePipelineManifest: validateBackend,
} = require('./pipelineManifests');

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'validator-parity-view',
    name: 'Validator Parity View',
    description: 'Shared validator contract coverage.',
    modality: 'scrna',
    tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject' }],
    ...overrides,
  };
}

function errorFrom(fn, value) {
  try {
    fn(value);
    return null;
  } catch (error) {
    return error;
  }
}

describe('shared declarative pipeline manifest contract', () => {
  it('normalizes the same complete manifest on the frontend and backend', () => {
    const input = manifest({
      tabs: [
        {
          id: 'qc',
          label: 'Quality Control',
          moduleKey: 'seuratQc',
          parameterSchema: [
            { key: 'threshold', type: 'number', label: 'Threshold', min: 0, max: 10, step: 0.5, default: 2 },
            { key: 'minimum-cells', type: 'integer', min: 1, max: 100, step: 1, default: 3 },
            { key: 'enabled', type: 'boolean', default: true },
            { key: 'notes', type: 'text', placeholder: 'Optional note', maxLength: 500, default: '' },
          ],
          resultViews: [{ type: 'summaryMetrics', title: 'QC summary' }, 'placeholder'],
        },
        {
          id: 'normalize',
          label: 'Normalize',
          moduleKey: 'seuratNormalize',
          parameterSchema: [{ key: 'method', type: 'enum', options: ['log', 'sct'], default: 'log' }],
        },
        {
          id: 'deg',
          label: 'Differential Expression',
          moduleKey: 'differentialExpression',
          resultArtifactTypes: ['deg_summary', 'deg_markers'],
          resultViews: [{ type: 'artifactTable', artifactType: 'deg_markers' }, 'jobLogs'],
        },
      ],
    });

    expect(validateFrontend(input)).toEqual(validateBackend(input));
    expect(getFrontendDefault()).toEqual(getBackendDefault());
  });

  it('rejects the same invalid corpus with identical messages', () => {
    const invalidInputs = [
      null,
      [],
      manifest({ schemaVersion: 2 }),
      manifest({ id: 'UPPER' }),
      manifest({ extra: true }),
      manifest({ tabs: [] }),
      manifest({ tabs: [{ id: 'wrong', label: 'Inspect', moduleKey: 'inspectObject' }] }),
      manifest({ tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject', code: 'system("env")' }] }),
      manifest({ tabs: [{ id: 'qc', label: 'QC', moduleKey: 'seuratQc', parameterSchema: [{ key: 'count', type: 'integer', default: 1.5 }] }] }),
      manifest({ tabs: [{ id: 'normalize', label: 'Normalize', moduleKey: 'seuratNormalize', parameterSchema: [{ key: 'method', type: 'enum', options: ['log'], default: 'sct' }] }] }),
      manifest({ tabs: [{ id: 'deg', label: 'DEG', moduleKey: 'differentialExpression', resultArtifactTypes: ['deg_summary'], resultViews: [{ type: 'artifactTable', artifactType: 'deg_markers' }] }] }),
      manifest({ description: '🧬'.repeat(33_000) }),
    ];

    for (const input of invalidInputs) {
      const frontendError = errorFrom(validateFrontend, input);
      const backendError = errorFrom(validateBackend, input);
      expect(frontendError).toBeInstanceOf(Error);
      expect(backendError).toBeInstanceOf(Error);
      expect(frontendError.message).toBe(backendError.message);
      expect(backendError.code).toBe('INVALID_PIPELINE_MANIFEST');
    }
  });

  it('derives execution authority only from code-shipped module metadata', () => {
    const executableModules = Object.entries(PIPELINE_CONTRACT.modules)
      .filter(([, definition]) => definition.executable === true || definition.jobType)
      .map(([moduleKey, definition]) => ({
        moduleKey,
        executable: definition.executable,
        jobType: definition.jobType,
      }));
    expect(executableModules).toEqual([{
      moduleKey: 'differentialExpression',
      executable: true,
      jobType: 'deg.find_markers.v1',
    }]);

    const resolved = resolvePipelineManifest(manifest({
      tabs: [
        { id: 'qc', label: 'Quality Control', moduleKey: 'seuratQc' },
        { id: 'deg', label: 'Differential Expression', moduleKey: 'differentialExpression' },
      ],
    }));
    expect(resolved.tabs.find((tab) => tab.moduleKey === 'seuratQc')).toEqual(expect.objectContaining({
      executable: false,
      jobType: null,
    }));
    expect(resolved.tabs.find((tab) => tab.moduleKey === 'differentialExpression')).toEqual(expect.objectContaining({
      executable: true,
      jobType: 'deg.find_markers.v1',
    }));
  });
});
