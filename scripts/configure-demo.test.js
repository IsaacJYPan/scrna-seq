import { describe, expect, it } from 'vitest';
const { generateDemoConfig } = require('./configure-demo');

function values(config) {
  return Object.fromEntries(
    config
      .split(/\r?\n/)
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

describe('demo configuration', () => {
  it('generates independent secrets and preserves the demo resource limits', () => {
    const first = values(generateDemoConfig('Demo.Example.org'));
    const second = values(generateDemoConfig('demo.example.org'));
    expect(first.PUBLIC_HOST).toBe('demo.example.org');
    expect(first.FRONTEND_ORIGIN).toBe('https://demo.example.org');
    expect(first.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(first.SESSION_EPOCH).toMatch(/^[0-9a-f]{32}$/);
    expect(first.R_API_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    const names = [
      'SESSION_SECRET',
      'SESSION_EPOCH',
      'R_API_TOKEN',
      'POSTGRES_PASSWORD',
      'APP_DATABASE_PASSWORD',
    ];
    expect(new Set(names.map((name) => first[name])).size).toBe(names.length);
    for (const name of names) expect(first[name]).not.toBe(second[name]);
    expect(first.EXPERT_R_ENABLED).toBe('false');
    expect(first.APP_DEPLOYMENT_MODE).toBe('demo');
    expect(first.R_MEMORY_LIMIT).toBe('2g');
    expect(first.DEMO_TEMPLATE_PROJECT_ID).toBe('proj_bootstrap_pending');
  });

  it.each([
    undefined,
    '',
    'localhost',
    '127.0.0.1',
    'https://example.org',
    'example.org:443',
    'example.org/path',
    'example.org\nEXPERT_R_ENABLED=true',
    '*.example.org',
    '-demo.example.org',
    'demo..org',
  ])('rejects invalid host %s', (host) => {
    expect(() => generateDemoConfig(host)).toThrow(/hostname/);
  });
});
