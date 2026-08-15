import { describe, expect, it } from 'vitest';

const { validateReplicates } = require('./experimentalDesign');

const A = 'cond_a';
const B = 'cond_b';
const sample = (id, conditionId, donorCode) => ({ id, condition_id: conditionId, donor_code: donorCode });

describe('experimental-design replicate validation', () => {
  it('rejects cell-level pseudoreplication and fewer than two biological samples', () => {
    const result = validateReplicates(
      [sample('s1', A, 'd1'), sample('s2', B, 'd2')],
      { numeratorConditionId: A, denominatorConditionId: B, unitOfReplication: 'sample', paired: false }
    );
    expect(result.status).toBe('invalid');
    expect(result.counts).toEqual({ numeratorSamples: 1, denominatorSamples: 1, numeratorUnits: 1, denominatorUnits: 1 });
    expect(result.issues[0]).toMatch(/two independent replication units/);
  });

  it('warns for two sample replicates and accepts three or more', () => {
    const two = [sample('a1', A), sample('a2', A), sample('b1', B), sample('b2', B)];
    expect(validateReplicates(two, {
      numeratorConditionId: A, denominatorConditionId: B, unitOfReplication: 'sample', paired: false,
    }).status).toBe('warning');
    const three = [...two, sample('a3', A), sample('b3', B)];
    expect(validateReplicates(three, {
      numeratorConditionId: A, denominatorConditionId: B, unitOfReplication: 'sample', paired: false,
    }).status).toBe('valid');
  });

  it('requires complete matched donor pairs for paired designs', () => {
    const incomplete = [
      sample('a1', A, 'd1'), sample('a2', A, 'd2'),
      sample('b1', B, 'd1'), sample('b2', B, 'd3'),
    ];
    const result = validateReplicates(incomplete, {
      numeratorConditionId: A, denominatorConditionId: B, unitOfReplication: 'donor', paired: true,
    });
    expect(result.status).toBe('invalid');
    expect(result.issues).toContain('Paired contrasts require the same donor codes in both conditions.');
  });

  it('requires donor codes when donor is the replication unit', () => {
    const result = validateReplicates(
      [sample('a1', A, null), sample('a2', A, 'd2'), sample('b1', B, 'd3'), sample('b2', B, 'd4')],
      { numeratorConditionId: A, denominatorConditionId: B, unitOfReplication: 'donor', paired: false }
    );
    expect(result.status).toBe('invalid');
    expect(result.issues[0]).toMatch(/donor code/);
  });
});
