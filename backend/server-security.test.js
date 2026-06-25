import { describe, it, expect } from 'vitest';
import serverModule from '../server.js';

const {
  resolveVaultPath,
  sanitizeVaultSegment
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

    expect(() => resolveVaultPath('../vault/alice_example_com/obj-1.rds', user)).toThrow(/relative vault path/i);
    expect(() => resolveVaultPath('C:\\Users\\alice\\obj-1.rds', user)).toThrow(/relative vault path/i);
  });
});
