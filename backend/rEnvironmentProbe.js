'use strict';

const { EXPERT_R_PROFILE, expertRProfileProbeCode } = require('./expertR');
const { validateEnvironmentManifest } = require('./rEnvironment');

function rEnvironmentProbeCode() {
  return `${expertRProfileProbeCode()}
pkgs <- installed.packages(noCache=TRUE)
pkgs <- pkgs[!duplicated(pkgs[, 'Package']), , drop=FALSE]
fields <- c('Repository','RemoteType','RemoteHost','RemoteUsername','RemoteRepo','RemoteRef','RemoteSha','git_url','git_branch','git_last_commit')
entries <- lapply(rownames(pkgs), function(name) {
  location <- find.package(name)
  description <- read.dcf(file.path(location, 'DESCRIPTION'), fields=fields)[1,]
  description <- as.list(description[!is.na(description) & nzchar(description)])
  list(name=name, version=as.character(packageVersion(name)), built=unname(pkgs[name,'Built']),
       priority=if (is.na(pkgs[name,'Priority'])) NULL else unname(pkgs[name,'Priority']), description=description)
})
inventory <- system2('dpkg-query', c('-W', shQuote('-f=\${Package}\\t\${Version}\\t\${Architecture}\\n')), stdout=TRUE)
system_packages <- lapply(strsplit(inventory, '\\t', fixed=FALSE), function(value) {
  if (length(value) != 3L) stop('System package inventory is invalid')
  list(name=value[[1]], version=value[[2]], architecture=value[[3]])
})
os_lines <- readLines('/etc/os-release', warn=FALSE)
os_value <- function(key) {
  value <- sub(paste0('^',key,'='), '', os_lines[startsWith(os_lines, paste0(key,'='))])
  if (length(value) != 1L) stop('Runtime distribution identity is unavailable')
  gsub('^"|"$', '', value)
}
cat(jsonlite::toJSON(list(r=list(version=as.character(getRversion()), platform=R.version$platform,
  bioconductor=as.character(BiocManager::version())), packages=entries, systemPackages=system_packages,
  distribution=list(id=os_value('ID'), version=os_value('VERSION_ID'))), auto_unbox=TRUE, null='null'))`;
}
function sourceMetadata(description, priority, rVersion) {
  const source = {};
  const fields = { RemoteType: 'remoteType', RemoteHost: 'remoteHost', RemoteUsername: 'remoteOwner',
    RemoteRepo: 'remoteRepo', RemoteRef: 'remoteRef', RemoteSha: 'remoteSha', git_branch: 'gitBranch', git_last_commit: 'gitCommit' };
  for (const [field, key] of Object.entries(fields)) {
    const value = description[field];
    if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value)
        && !value.includes('://') && !value.includes('..')) source[key] = value;
  }
  for (const [field, key] of [['Repository', 'repository'], ['git_url', 'gitUrl']]) {
    const value = description[field];
    if (typeof value !== 'string') continue;
    if (/^https?:\/\//.test(value)) {
      try {
        const url = new URL(value);
        if (!url.username && !url.password && !url.search && !url.hash) source[key === 'repository' ? 'url' : key] = url.toString();
      } catch { /* Unsafe or unavailable origins are reported as unrecorded. */ }
    } else if (key === 'repository' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value)) source[key] = value;
  }
  if (!Object.keys(source).length && ['base', 'recommended'].includes(priority)) return { kind: 'r-distribution', url: `https://cran.r-project.org/src/base/R-${rVersion.split('.')[0]}/R-${rVersion}.tar.gz` };
  return { kind: Object.keys(source).length ? 'recorded' : 'unrecorded', ...source };
}
function buildEnvironmentManifest(probe, image, imageReference) {
  if (!probe || !Array.isArray(probe.packages) || !image) throw new Error('Exact R environment discovery failed.');
  return validateEnvironmentManifest({
    schema: 'traceomics.r-environment.v1', profileId: EXPERT_R_PROFILE.id,
    runtime: { imageReference, imageDigest: imageReference.slice(imageReference.lastIndexOf('sha256:')),
      imageId: image.imageId, os: image.os, architecture: image.architecture,
      distribution: probe.distribution, snapshotScope: 'container-userspace', kernel: 'worker-host' },
    r: probe.r, packages: probe.packages.map(pkg => ({ name: pkg.name, version: pkg.version,
      ...(pkg.built ? { built: pkg.built } : {}), ...(pkg.priority ? { priority: pkg.priority } : {}),
      source: sourceMetadata(pkg.description || {}, pkg.priority, probe.r.version) })),
    systemPackages: probe.systemPackages,
    lock: { format: 'installed-package-inventory.v1', sourceArchivesIncluded: false },
  });
}
module.exports = { rEnvironmentProbeCode, sourceMetadata, buildEnvironmentManifest };
