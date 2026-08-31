'use strict';

const contract = require('../shared/passwordPolicyContract.json');

const COMMON_PASSWORDS = new Set([
  '123456789012345',
  'adminadminadmin',
  'changemechangeme',
  'letmeinletmein',
  'passwordpassword',
  'password123456',
  'qwertyqwertyqwerty',
  'traceomicstraceomics',
  'welcome123456789',
]);

function characterLength(value) {
  return Array.from(value).length;
}

function comparable(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function accountTerms({ email = '', displayName = '' } = {}) {
  const localPart = comparable(email).split('@')[0];
  const displayParts = comparable(displayName).split(/[^\p{L}\p{N}]+/u);
  return [localPart, ...displayParts].filter((term) => term.length >= 4);
}

function validateNewPassword(value, context = {}) {
  if (typeof value !== 'string') {
    return { error: 'Password is required.' };
  }

  const length = characterLength(value);
  if (length < contract.minLength) {
    return { error: `Password must be at least ${contract.minLength} characters.` };
  }
  if (length > contract.maxLength) {
    return { error: `Password must be at most ${contract.maxLength} characters.` };
  }
  if (value.includes('\0')) {
    return { error: 'Password cannot contain a NUL character.' };
  }

  const normalized = comparable(value);
  if (COMMON_PASSWORDS.has(normalized)) {
    return { error: 'Choose a less common password or passphrase.' };
  }
  if (/^(.)\1{14,}$/u.test(normalized)) {
    return { error: 'Choose a less repetitive password or passphrase.' };
  }
  if (accountTerms(context).some((term) => normalized.includes(term))) {
    return { error: 'Password must not contain your name or email username.' };
  }

  return { password: value };
}

function publicPasswordPolicy() {
  return {
    version: contract.version,
    minLength: contract.minLength,
    maxLength: contract.maxLength,
  };
}

module.exports = {
  COMMON_PASSWORDS,
  characterLength,
  publicPasswordPolicy,
  validateNewPassword,
};
