import { describe, it, expect } from 'vitest';

const { currentReleases, validateScalar } = require('./workflowTrust/catalog');

describe('workflow release catalog', () => {
  const releases = currentReleases();
  const byKey = (key) => releases.find((release) => release.key === key);

  it('has one release per job type, except explore releases with disjoint recipes', () => {
    const byJobType = new Map();
    for (const release of releases) {
      if (release.jobType === 'trusted.method.v1') continue;
      byJobType.set(release.jobType, [...(byJobType.get(release.jobType) || []), release]);
    }
    for (const [jobType, group] of byJobType) {
      if (jobType !== 'explore.summarize.v1') {
        expect(group.map((r) => r.key), jobType).toHaveLength(1);
        continue;
      }
      const recipes = group.map((r) => r.definition.parameterSchema.recipe.values);
      const all = recipes.flat();
      expect(new Set(all).size).toBe(all.length);
    }
    expect(byKey('ranked-enrichment')).toBeUndefined();
    expect(byKey('cellchat-candidates')).toBeUndefined();
    expect(byKey('pathway-gsea')).toBeDefined();
    expect(byKey('cellchat-single-context')).toBeDefined();
  });

  it('declares every composed input source as a fromReleases array', () => {
    for (const release of releases) {
      for (const input of release.definition.inputs.filter((i) => i.kind === 'analysis_object')) {
        expect(input.fromRelease, release.key).toBeUndefined();
        expect(Array.isArray(input.fromReleases), release.key).toBe(true);
        expect(input.fromReleases.every((key) => typeof key === 'string'), release.key).toBe(true);
      }
    }
  });

  it('marks what a study asks as design choices a person fixes', () => {
    expect(byKey('condition-pseudobulk').definition.parameterSchema.contrastId.role).toBe('design');
    const workbench = byKey('study-workbench').definition.parameterSchema;
    for (const name of ['contrastId', 'groupMap', 'conditionName', 'targetGroup', 'species']) {
      expect(workbench[name].role, name).toBe('design');
    }
    expect(workbench.featureNames.role).toBeUndefined();
    expect(workbench.numerator).toBeUndefined();
    expect(workbench.denominator).toBeUndefined();
  });

  it('runs workbench contrast recipes only on a registered contrast', () => {
    const workbench = byKey('study-workbench');
    expect(() => workbench.validateParameters({ recipe: 'study_de' })).toThrow(/contrastId/);
    expect(() => workbench.validateParameters({ recipe: 'study_de', numerator: 'a', denominator: 'b' })).toThrow();
    expect(workbench.validateParameters({
      recipe: 'study_pathways', contrastId: 'contrast_ab12', targetGroup: 'T', species: 'mouse',
    })).toMatchObject({ recipe: 'study_pathways', contrastId: 'contrast_ab12', species: 'mouse' });
    expect(() => workbench.validateParameters({ recipe: 'study_qc', contrastId: 'contrast_ab12' })).toThrow();
    const outputs = workbench.definition.outputs.map((o) => o.artifactType);
    expect(outputs).toContain('study_inference_summary');
  });

  it('requires an explicit organism for pathway and communication recipes', () => {
    const workbench = byKey('study-workbench');
    expect(() => workbench.validateParameters({ recipe: 'study_pathways', contrastId: 'contrast_ab12', targetGroup: 'T' }))
      .toThrow(/species/);
    expect(() => workbench.validateParameters({ recipe: 'study_communication', conditionName: 'control' }))
      .toThrow(/species/);
    expect(() => workbench.validateParameters({ recipe: 'study_communication', conditionName: 'control', species: 'rat' }))
      .toThrow(/species/);
    expect(workbench.validateParameters({ recipe: 'study_communication', conditionName: 'control', species: 'human' }).species)
      .toBe('human');
    expect(() => workbench.validateParameters({ recipe: 'study_qc', species: 'human' })).toThrow(/species/);
  });

  it('no longer accepts the unused sampleInputs parameter type', () => {
    expect(() => validateScalar({ samples: { type: 'sampleInputs' } }, 'samples', [])).toThrow();
  });
});
