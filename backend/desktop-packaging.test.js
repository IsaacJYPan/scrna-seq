import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const buildConfig = require('../electron-builder.config.cjs');

describe('Windows release packaging contract', () => {
  it('uses product-owned executable metadata and a stable artifact name', () => {
    expect(pkg.author).toEqual({ name: 'TraceOmics' });
    expect(buildConfig).toMatchObject({
      appId: 'org.traceomics.workbench',
      productName: 'TraceOmics',
      artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
      forceCodeSigning: true,
      win: {
        requestedExecutionLevel: 'asInvoker',
        verifyUpdateCodeSignature: true,
      },
    });
    expect(buildConfig.copyright).toMatch(/TraceOmics/);
  });

  it('separates unsigned local acceptance from signed release builds', () => {
    expect(pkg.scripts['desktop:package']).toContain('forceCodeSigning=false');
    expect(pkg.scripts['desktop:dist:unsigned']).toContain('forceCodeSigning=false');
    expect(pkg.scripts['desktop:dist']).not.toContain('forceCodeSigning=false');
  });

  it('uses an assisted installer with explicit shortcuts and uninstall identity', () => {
    expect(buildConfig.nsis).toEqual(expect.objectContaining({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
      shortcutName: 'TraceOmics',
      uninstallDisplayName: 'TraceOmics',
    }));
  });

  it('does not ship the placeholder setup mark', () => {
    const setup = fs.readFileSync(path.join(root, 'desktop', 'setup.html'), 'utf8');
    expect(setup).not.toContain('class="mark" aria-hidden="true">B<');
    expect(setup).toContain('<svg viewBox="0 0 32 32"');
  });
});
