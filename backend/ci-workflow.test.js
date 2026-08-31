import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const workflowDir = path.join(root, '.github', 'workflows');
const workflowFiles = fs.readdirSync(workflowDir)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(workflowDir, name), 'utf8') }));

describe('continuous-integration workflow contracts', () => {
  it('pins third-party actions to immutable commit SHAs', () => {
    for (const workflow of workflowFiles) {
      const actionRefs = [...workflow.text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)]
        .map((match) => match[1]);
      expect(actionRefs.length, `${workflow.name} should use at least one action`).toBeGreaterThan(0);
      for (const actionRef of actionRefs) {
        expect(actionRef, `${workflow.name}: ${actionRef}`).toMatch(/^[^@]+@[a-f0-9]{40}$/);
      }
    }
  });

  it('keeps signed and unsigned Windows packaging paths distinct', () => {
    const release = workflowFiles.find(({ name }) => name === 'release-certification.yml')?.text || '';
    expect(release).toContain('WINDOWS_CSC_LINK');
    expect(release).toContain('npm run desktop:dist');
    expect(release).not.toContain('npm run desktop:dist:unsigned');
    expect(release).toContain('verify-windows-installer.ps1');
  });

  it('configures bounded dependency-update queues for npm and workflow actions', () => {
    const dependabot = fs.readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8');
    expect(dependabot).toContain('package-ecosystem: npm');
    expect(dependabot).toContain('package-ecosystem: github-actions');
    expect(dependabot).toMatch(/open-pull-requests-limit:\s*[1-9]/g);
  });

  it('installs only the browser engine used by acceptance scripts', () => {
    const ci = workflowFiles.find(({ name }) => name === 'ci.yml')?.text || '';
    expect(ci).toContain('npx playwright install --with-deps chromium');
    expect(ci).not.toMatch(/npx playwright install --with-deps\s*(?:#.*)?$/m);
  });

  it('builds the SPA before backend fallback coverage runs', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const preflight = packageJson.scripts?.['check:ci-preflight'] || '';
    expect(preflight.indexOf('npm run build')).toBeGreaterThan(-1);
    expect(preflight.indexOf('npm run build')).toBeLessThan(preflight.indexOf('npm run test:backend'));
  });
});
