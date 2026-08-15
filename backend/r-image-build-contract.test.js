import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDirectory, '..');
const dockerfile = fs.readFileSync(path.join(root, 'r-backend', 'Dockerfile'), 'utf8');
const installer = fs.readFileSync(path.join(root, 'r-backend', 'install-r-packages.sh'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

describe('production R image build contract', () => {
  it('isolates and bounds the noisy RcppEigen source compilation', () => {
    const rcppEigenInstall = dockerfile.indexOf("install.packages('RcppEigen'");
    const seuratInstall = dockerfile.indexOf("install.packages(c('plumber'");

    expect(rcppEigenInstall).toBeGreaterThan(-1);
    expect(seuratInstall).toBeGreaterThan(rcppEigenInstall);
    expect(dockerfile).toContain('-Wno-ignored-attributes');
    expect(dockerfile).toContain('install-r-packages RcppEigen');
    expect(installer).toContain('MAKEFLAGS=-j1');
    expect(installer).toContain('installation is still running');
    expect(installer).toContain("grep -Eq '^ERROR:|non-zero exit status'");
    expect(installer).toContain('tail -n 200');
    expect(installer).toContain('exit "$status"');
  });

  it('keeps the exact R image job bounded while retaining runtime audits', () => {
    const jobStart = workflow.indexOf('  r-image-smoke:');
    const job = workflow.slice(jobStart);

    expect(jobStart).toBeGreaterThan(-1);
    expect(job).toMatch(/timeout-minutes:\s*60/);
    expect(job).toContain('Build exact R runtime image');
    expect(job).toContain('Verify required R packages');
    expect(job).toContain('Boot R image and audit authenticated health');
    expect(dockerfile).toContain("'edgeR', 'limma'");
    expect(job).toContain("'edgeR','limma'");
  });
});
