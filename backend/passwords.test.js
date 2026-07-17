import { describe, expect, it } from 'vitest';

const passwords = require('./passwords');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('password hashing', () => {
  it('uses the fixed credential format and verifies asynchronously', async () => {
    const salt = '7a3f1c8e5d2b9046a8c1e3f597b2d4f6';
    const stored = await passwords.hashPassword('correct horse battery staple', salt);

    expect(stored).toMatch(/^\$pbkdf2-sha512\$i=600000\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    await expect(passwords.verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
    await expect(passwords.verifyPassword('wrong password', stored)).resolves.toBe(false);
  });

  it('rejects malformed or attacker-selected iteration hashes after bounded dummy work', async () => {
    const attackerHash = `$pbkdf2-sha512$i=999999999$${'a'.repeat(32)}$${'b'.repeat(128)}`;
    await expect(passwords.verifyPassword('password123', attackerHash)).resolves.toBe(false);
    await expect(passwords.verifyPassword('password123', null)).resolves.toBe(false);
  });
});

describe('password work admission', () => {
  it('bounds active and queued work and rejects excess globally', async () => {
    const admission = passwords.createAdmissionController({ maxActive: 1, maxQueued: 1 });
    const firstGate = deferred();
    const secondGate = deferred();
    const first = admission.run(() => firstGate.promise);
    const second = admission.run(() => secondGate.promise);
    const overflow = admission.run(() => Promise.resolve('must-not-run'));

    expect(admission.snapshot()).toEqual({ active: 1, queued: 1, maxActive: 1, maxQueued: 1 });
    await expect(overflow).rejects.toMatchObject({ code: 'AUTH_HASH_BUSY' });

    firstGate.resolve('first');
    await expect(first).resolves.toBe('first');
    await Promise.resolve();
    expect(admission.snapshot().active).toBe(1);

    secondGate.resolve('second');
    await expect(second).resolves.toBe('second');
    await Promise.resolve();
    expect(admission.snapshot()).toEqual({ active: 0, queued: 0, maxActive: 1, maxQueued: 1 });
  });
});
