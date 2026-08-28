import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import config from './desktopConfig.cjs';

const { isAllowedNavigation, normalizeServerUrl, verifyServerConnection } = config;

describe('desktop server configuration', () => {
  it('loads the CommonJS configuration module with its explicit extension', () => {
    const mainSource = fs.readFileSync(path.resolve(process.cwd(), 'desktop', 'main.cjs'), 'utf8');
    expect(mainSource).toContain("require('./desktopConfig.cjs')");
  });

  it('enables the software WebGL fallback before opening visualizations', () => {
    const mainSource = fs.readFileSync(path.resolve(process.cwd(), 'desktop', 'main.cjs'), 'utf8');
    expect(mainSource).toContain("app.commandLine.appendSwitch('enable-webgl')");
    expect(mainSource).toContain("app.commandLine.appendSwitch('ignore-gpu-blocklist')");
    expect(mainSource).not.toContain("app.commandLine.appendSwitch('use-angle', 'swiftshader')");
  });

  it('exposes native product identity and an About surface', () => {
    const mainSource = fs.readFileSync(path.resolve(process.cwd(), 'desktop', 'main.cjs'), 'utf8');
    expect(mainSource).toContain("app.setAppUserModelId('org.traceomics.workbench')");
    expect(mainSource).toContain("label: 'About TraceOmics'");
    expect(mainSource).toContain('app.getVersion()');
  });

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

  it('verifies a TraceOmics policy response before accepting a server', async () => {
    const fetchImpl = async (url, options) => {
      expect(url.toString()).toBe('https://analysis.example.org/api/auth/policy');
      expect(options).toMatchObject({ method: 'GET' });
      return { ok: true, json: async () => ({ registrationEnabled: false }) };
    };
    await expect(verifyServerConnection('https://analysis.example.org', { fetchImpl }))
      .resolves.toBe('https://analysis.example.org');
  });

  it('rejects reachable non-TraceOmics sites with a stable explanation', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
    await expect(verifyServerConnection('https://example.org', { fetchImpl }))
      .rejects.toThrow(/not a compatible TraceOmics server/i);
  });
});
