import { describe, expect, it } from 'vitest';
import config from './desktopConfig.cjs';

const { isAllowedNavigation, normalizeServerUrl } = config;

describe('desktop server configuration', () => {
  it('accepts HTTPS servers and local HTTP development servers', () => {
    expect(normalizeServerUrl('https://analysis.example.org/')).toBe('https://analysis.example.org');
    expect(normalizeServerUrl('http://localhost:3000/')).toBe('http://localhost:3000');
  });

  it('rejects unsafe server addresses', () => {
    expect(() => normalizeServerUrl('http://analysis.example.org')).toThrow(/HTTPS/);
    expect(() => normalizeServerUrl('https://user:password@analysis.example.org')).toThrow(/credentials/);
    expect(() => normalizeServerUrl('file:///etc/passwd')).toThrow(/HTTPS/);
  });

  it('keeps in-app navigation on the configured server origin', () => {
    expect(isAllowedNavigation('https://analysis.example.org/login', 'https://analysis.example.org')).toBe(true);
    expect(isAllowedNavigation('https://untrusted.example.org', 'https://analysis.example.org')).toBe(false);
  });
});
