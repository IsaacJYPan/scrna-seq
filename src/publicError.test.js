import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_ERROR, isTransientComputeBusy, publicErrorMessage } from './publicError';
import { TARGET_CHANGED_MESSAGE, TARGET_CHECKING_MESSAGE, TARGET_DISCONNECTED_MESSAGE, TARGET_UNCONFIRMED_MESSAGE } from './runtime/executionTarget';
import { SUBMISSION_RECOVERY_MESSAGES } from './executions/submissionRecoveryMessages';

describe('publicErrorMessage', () => {
  it('preserves generic credential rejection without exposing authentication diagnostics', () => {
    expect(publicErrorMessage('{"error":"Invalid email or password."}')).toBe('Invalid email or password.');
    expect(publicErrorMessage('Invalid email or password. Internal server diagnostic')).toBe(DEFAULT_PUBLIC_ERROR);
    expect(publicErrorMessage('Account ui-review@example.invalid was not found')).not.toContain('ui-review@example.invalid');
  });
  it('preserves only the fixed safe submission-recovery instructions', () => {
    for (const message of Object.values(SUBMISSION_RECOVERY_MESSAGES)) expect(publicErrorMessage(new Error(message))).toBe(message);
    expect(publicErrorMessage('An earlier submission has not been confirmed: /__private_vault__/source.R')).toBe(DEFAULT_PUBLIC_ERROR);
    expect(publicErrorMessage({ code: 'SUBMISSION_UNCONFIRMED', message: 'Private server diagnostic' })).toBe(DEFAULT_PUBLIC_ERROR);
  });
  it('preserves fixed reconnect and unconfirmed-execution instructions', () => {
    for (const message of [TARGET_CHANGED_MESSAGE,TARGET_CHECKING_MESSAGE,TARGET_DISCONNECTED_MESSAGE,TARGET_UNCONFIRMED_MESSAGE]) expect(publicErrorMessage(message)).toBe(message);
  });
  it('preserves short actionable scientific and access feedback', () => {
    expect(publicErrorMessage('No cells matched these filters.')).toBe('No cells matched these filters.');
    expect(publicErrorMessage('Select a saved analysis before continuing.')).toBe('Select a saved analysis before continuing.');
    expect(publicErrorMessage('permission denied')).toBe('You do not have access to this project action.');
  });

  it('replaces infrastructure, path, state, and identifier details', () => {
    const raw = 'Error in Rscript: /__private_vault__/proj_123/job_456.rds state_key=user-7:obj-private';
    expect(publicErrorMessage(raw)).toBe(DEFAULT_PUBLIC_ERROR);
    expect(publicErrorMessage('{"error":"https://runtime.internal/api/r failed"}')).toBe(DEFAULT_PUBLIC_ERROR);
    expect(publicErrorMessage('unknown backend exception')).toBe(DEFAULT_PUBLIC_ERROR);
  });

  it('maps shared compute contention to a short actionable explanation', () => {
    const expected = 'Analysis compute is busy. Wait a moment and try again.';
    expect(publicErrorMessage('R service is busy. Please retry shortly.')).toBe(expected);
    expect(publicErrorMessage(expected)).toBe(expected);
    expect(isTransientComputeBusy('R service is busy. Please retry shortly.')).toBe(true);
    expect(isTransientComputeBusy('R request failed.')).toBe(false);
  });
});
