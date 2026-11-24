import { describe, expect, it } from 'vitest';

const { describeLocalRuntime } = require('./pin-local-runtime');

describe('pinning a plain R installation', () => {
  it('describes the install with the R service code and validates the profile', () => {
    const calls = [];
    const profile = describeLocalRuntime({
      rscript: 'Rscript', root: '/app',
      exec: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return JSON.stringify({ schema: 'traceomics.workflow-runtime.v1', imageDigest: `sha256:${'b'.repeat(64)}`, rVersion: '4.5.1',
          packages: [{ name: 'Seurat', version: '5.3.0' }, { name: 'base', version: '4.5.1' }] });
      },
    });
    expect(profile.imageDigest).toBe(`sha256:${'b'.repeat(64)}`);
    expect(profile.packages.map((p) => p.name)).toEqual(['base', 'Seurat']);
    expect(calls[0].options.env.TRACEOMICS_RUNTIME_LOCAL_INSTALL).toBe('1');
    expect(calls[0].args.join(' ')).toContain('workflowTrust.R');
  });

  it('refuses an install that reports no runtime digest', () => {
    expect(() => describeLocalRuntime({ exec: () => JSON.stringify({ schema: 'traceomics.workflow-runtime.v1', imageDigest: '', rVersion: '4.5.1', packages: [{ name: 'base', version: '4.5.1' }] }) }))
      .toThrow(/pinned workflow runtime/);
  });
});
