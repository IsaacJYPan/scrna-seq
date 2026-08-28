import { describe, expect, it } from 'vitest';

const {
  characterLength,
  publicPasswordPolicy,
  validateNewPassword,
} = require('./passwordPolicy');

describe('new-password policy', () => {
  it('publishes the bounded client contract', () => {
    expect(publicPasswordPolicy()).toEqual({ version: 1, minLength: 15, maxLength: 1024 });
  });

  it('counts Unicode code points instead of UTF-16 code units', () => {
    expect(characterLength('🔬'.repeat(15))).toBe(15);
    const password = '🔬violet harbor orbits';
    expect(validateNewPassword(password)).toEqual({ password });
  });

  it('rejects short, common, repetitive, and account-derived passwords', () => {
    expect(validateNewPassword('short')).toEqual({ error: 'Password must be at least 15 characters.' });
    expect(validateNewPassword('passwordpassword')).toEqual({ error: 'Choose a less common password or passphrase.' });
    expect(validateNewPassword('aaaaaaaaaaaaaaa')).toEqual({ error: 'Choose a less repetitive password or passphrase.' });
    expect(validateNewPassword('Researcher-has-a-long-secret', {
      email: 'researcher@example.org',
      displayName: 'Taylor Example',
    })).toEqual({ error: 'Password must not contain your name or email username.' });
  });

  it('accepts long passphrases without composition rules', () => {
    const password = 'violet harbor orbits calmly';
    expect(validateNewPassword(password, {
      email: 'researcher@example.org',
      displayName: 'Taylor Example',
    })).toEqual({ password });
  });
});
