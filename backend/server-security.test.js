import { describe, it, expect } from 'vitest';
import path from 'path';
import serverModule from '../server.js';

const {
  resolveVaultPath,
  sanitizeVaultSegment,
  deriveRStateKey
} = serverModule;

describe('server vault path authorization', () => {
  it('allows a user to access paths inside their own vault folder', () => {
    const user = { email: 'alice@example.com' };
    const path = `vault/${sanitizeVaultSegment(user.email)}/obj-1.rds`;

    expect(resolveVaultPath(path, user).replace(/\\/g, '/')).toBe(path);
  });

  it('rejects paths inside another user vault folder', () => {
    const alicePath = `vault/${sanitizeVaultSegment('alice@example.com')}/obj-1.rds`;
    const bob = { email: 'bob@example.com' };

    expect(() => resolveVaultPath(alicePath, bob)).toThrow(/authenticated user vault/i);
  });

  it('rejects traversal and absolute paths before they reach R', () => {
    const user = { email: 'alice@example.com' };
    const absolutePath = path.join(path.parse(process.cwd()).root, 'tmp', 'obj-1.rds');

    expect(() => resolveVaultPath('../vault/alice_example_com/obj-1.rds', user)).toThrow(/relative vault path/i);
    expect(() => resolveVaultPath(absolutePath, user)).toThrow(/relative vault path/i);
  });
});

describe('R state key derivation', () => {
  it('always prefixes with the server-controlled user id', () => {
    expect(deriveRStateKey({ id: 7 }, undefined)).toBe('user-7');
    expect(deriveRStateKey({ id: 7 }, 'dataset-1')).toBe('user-7:obj-dataset-1');
  });

  it('keeps two objects for the same user on separate keys', () => {
    const a = deriveRStateKey({ id: 7 }, 'dataset-1');
    const b = deriveRStateKey({ id: 7 }, 'dataset-2');
    expect(a).not.toBe(b);
  });

  it('namespaces object ids under the user, so a client cannot reach another user’s state', () => {
    // Even if user 7 supplies an object id that embeds another user's id,
    // the server-set prefix keeps it inside user 7's own namespace.
    const forged = deriveRStateKey({ id: 7 }, 'user-8:obj-secret');
    expect(forged.startsWith('user-7:')).toBe(true);
    expect(forged).not.toBe(deriveRStateKey({ id: 8 }, 'secret'));
  });

  it('sanitizes object ids to a safe character set', () => {
    expect(deriveRStateKey({ id: 7 }, '../../etc/passwd')).toBe('user-7:obj-etc_passwd');
    expect(deriveRStateKey({ id: 7 }, '   ')).toBe('user-7');
  });

  it('requires an authenticated user', () => {
    expect(() => deriveRStateKey(null, 'x')).toThrow(/authenticated user/i);
    expect(() => deriveRStateKey({}, 'x')).toThrow(/authenticated user/i);
  });
});
