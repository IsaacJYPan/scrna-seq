import { describe, expect, it } from 'vitest';

const { isDisposableTestDatabase } = require('./pgDatabase');

describe('resetSchemaForTests database guard', () => {
  it('accepts databases named as test or CI databases', () => {
    for (const name of ['scrna_test', 'test', 'ci', 'app-ci', 'TEST_scrna', 'scrna_test_2']) {
      expect(isDisposableTestDatabase(name, {})).toBe(true);
    }
  });

  it('refuses development and production databases without an explicit opt-in', () => {
    for (const name of ['scrna', 'scrna_dev', 'latest', 'contest', 'scrna_testing', '', null]) {
      expect(isDisposableTestDatabase(name, {})).toBe(false);
    }
  });

  it('allows a disposable database with another name only when the caller opts in', () => {
    expect(isDisposableTestDatabase('scrna_browser_smoke_1', { TRACEOMICS_ALLOW_SCHEMA_RESET: '1' })).toBe(true);
    expect(isDisposableTestDatabase('scrna', { TRACEOMICS_ALLOW_SCHEMA_RESET: 'true' })).toBe(false);
  });
});
