'use strict';
const { summarizeEnvironmentManifest, validateEnvironmentManifest } = require('./rEnvironment');
function environmentFixture(hash = 'a') {
  const manifest = { schema: 'traceomics.r-environment.v1', profileId: 'scrna-r-4.5-bioconductor-3.22-v1',
    runtime: { imageReference: `sha256:${hash.repeat(64)}`, imageDigest: `sha256:${hash.repeat(64)}`, imageId: `sha256:${hash.repeat(64)}`,
      os: 'linux', architecture: 'amd64', distribution: { id: 'ubuntu', version: '24.04' }, snapshotScope: 'container-userspace', kernel: 'worker-host' },
    r: { version: '4.5.3', platform: 'x86_64-pc-linux-gnu', bioconductor: '3.22' },
    packages: [{ name: 'base', version: '4.5.3', built: '4.5.3', priority: 'base', source: { kind: 'r-distribution', url: 'https://cran.r-project.org/src/base/R-4/R-4.5.3.tar.gz' } },
      { name: 'Seurat', version: '5.3.0', built: '4.5.3', source: { kind: 'recorded', repository: 'CRAN' } }],
    systemPackages: [{ name: 'libc6', version: '2.39-0ubuntu8.6', architecture: 'amd64' }], lock: { format: 'installed-package-inventory.v1', sourceArchivesIncluded: false } };
  return { manifest: validateEnvironmentManifest(manifest), reference: summarizeEnvironmentManifest(manifest) };
}
module.exports = { environmentFixture };
