#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const composeFile = path.join(root, 'deploy', 'compose.single-host.yml');
const overlayFile = path.join(root, 'deploy', 'compose.private-compute-acceptance.yml');
const nativeUiOverlayFile = path.join(root, 'deploy', 'compose.native-ui-acceptance.yml');
const nativeUiAcceptance = process.env.RUN_NATIVE_UI_ACCEPTANCE === 'true';
const acceptanceRoot = path.join(root, 'playwright', 'report', 'release-acceptance');
const project = `traceomics-private-accept-${process.pid}-${Date.now()}`.toLowerCase();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-private-compute-'));
const envFile = path.join(tempRoot, 'acceptance.env');
const webPort = 39000 + crypto.randomInt(500);

function secret(bytes) { return crypto.randomBytes(bytes).toString('hex'); }

fs.writeFileSync(envFile, [
  'FRONTEND_ORIGIN=https://127.0.0.1',
  'APP_DEPLOYMENT_MODE=private',
  `WEB_PORT=${webPort}`,
  'TRUST_PROXY_HOPS=1',
  'COOKIE_SAMESITE=Lax',
  `SESSION_SECRET=${secret(32)}`,
  `SESSION_EPOCH=${secret(16)}`,
  `R_API_TOKEN=${secret(32)}`,
  `POSTGRES_PASSWORD=${secret(24)}`,
  'POSTGRES_USER=traceomics_accept',
  'POSTGRES_DB=traceomics_accept',
  'APP_IMAGE=traceomics:single-host',
  'OPS_IMAGE=traceomics-operations:single-host',
  'R_IMAGE=traceomics-r:single-host',
  'NAMESPACE_IMAGE=alpine:3.21',
  'POSTGRES_IMAGE=postgres:16-alpine',
  'BACKUP_HOST_PATH=C:/traceomics-private-accept-backups',
  'APP_UID=10001',
  'APP_GID=10001',
  'POSTGRES_MEMORY_LIMIT=1g',
  'POSTGRES_CPU_LIMIT=1',
  'POSTGRES_SHM_SIZE=256m',
  'R_MEMORY_LIMIT=4g',
  'R_CPU_LIMIT=2',
  'R_COMPUTE_MEMORY_LIMIT=4g',
  'R_COMPUTE_CPU_LIMIT=2',
  'R_COMPUTE_SESSION_BYTES=3221225472',
  'R_COMPUTE_SESSION_BYTES_PER_JOB=2147483648',
  'WEB_MEMORY_LIMIT=1g',
  'WEB_CPU_LIMIT=1',
  'WORKER_MEMORY_LIMIT=1g',
  'WORKER_CPU_LIMIT=1',
  'OPS_MEMORY_LIMIT=1g',
  'OPS_CPU_LIMIT=1',
  'JOB_WORKER_MIN_FREE_MEMORY_MB=1',
  'EXPERT_R_ENABLED=false',
  'EXPERT_R_SANDBOX_TOKEN=disabled',
  'EXPERT_R_SANDBOX_IMAGE=disabled',
  'EXPERT_R_SANDBOX_HOST_WORK_ROOT=C:/traceomics-private-accept-expert',
  '',
].join('\n'), { mode: 0o600 });

const composeArgs = [
  'compose', '-p', project, '--env-file', envFile,
  '-f', composeFile, '-f', overlayFile,
];
if (nativeUiAcceptance) composeArgs.push('-f', nativeUiOverlayFile);

function runDocker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout || ''}\n${result.stderr || ''}` : '';
    const command = args.map((arg, index) => (
      index > 0 && args[index - 1] === '-e' && String(arg).startsWith('eval(')
        ? '<reviewed-inline-harness>' : arg
    )).join(' ');
    throw new Error(`docker ${command} failed${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout || '';
}

function compose(extra, options) { return runDocker([...composeArgs, ...extra], options); }

function inner(action, input) {
  const args = ['exec', '-T', '-e', `ACCEPTANCE_ACTION=${action}`];
  if (input) args.push('-e', `ACCEPTANCE_INPUT=${JSON.stringify(input)}`);
  args.push('web', 'node', '/app/acceptance/compose-private-compute-inner.js');
  const stdout = compose(args, { capture: true });
  const lines = stdout.trim().split(/\r?\n/);
  const marker = [...lines].reverse().find((line) => line.startsWith('ACCEPTANCE_JSON='));
  if (!marker) throw new Error(`acceptance action ${action} returned no result\n${stdout}`);
  return JSON.parse(marker.slice('ACCEPTANCE_JSON='.length));
}

function createCheckpoints(seedResult, { includePca = false } = {}) {
  const lanes = seedResult.lanes;
  const laneJson = JSON.stringify(lanes.map((lane) => ({
    index: lane.index,
    path: `/app/storage-volume/data/${lane.checkpointKey}`,
  })));
  const expression = `
    suppressPackageStartupMessages({library(Seurat); library(Matrix); library(jsonlite)})
    human_symbols <- c(
      'IL7R','LST1','S100A8','S100A9','MS4A1','CD79A','NKG7','GNLY','LTB','CCL5',
      'FCGR3A','CTSS','TYROBP','LGALS3','FCER1A','CST3','LILRB1','AIF1','IFITM3','MALAT1',
      'ACTB','GAPDH','B2M','HLA-DRA','HLA-DPB1','HLA-DPA1','CD3D','CD3E','TRBC1','TRBC2',
      'CCR7','IL32','GZMB','PRF1','CTSW','KLRD1','CD14','LYZ','CTSB','CTSD',
      'FCN1','MNDA','SAT1','IFI30','SERPINA1','CFD','PPBP','PF4','GNG11','MKI67',
      'TOP2A','STMN1','TUBA1B','RPLP0','RPS18','JUN','FOS','JUNB','DUSP1','IER2',
      'ISG15','IFIT1','IFIT2','IFIT3','MX1','OAS1','OAS2','STAT1','IRF7','IFI6',
      'CXCL8','CXCR4','SELL','ITGAM','ITGAX','CD68','CSF1R','SPI1','CEBPA','CEBPB'
    )
    signaling_symbols <- if (requireNamespace('CellChat', quietly=TRUE)) {
      unique(CellChat::extractGene(CellChat::CellChatDB.human))
    } else character()
    fixture_symbols <- unique(c(human_symbols, signaling_symbols))
    lanes <- fromJSON('${laneJson.replace(/'/g, "\\'")}')
    for (i in seq_len(nrow(lanes))) {
      set.seed(4100 + lanes$index[[i]])
      counts <- matrix(rpois(240 * 400, lambda=1), nrow=240, ncol=400)
      selected_symbols <- head(fixture_symbols, nrow(counts))
      filler_symbols <- if (length(selected_symbols) < nrow(counts)) {
        paste0('Gene', seq_len(nrow(counts) - length(selected_symbols)))
      } else character()
      rownames(counts) <- c(selected_symbols, filler_symbols)
      colnames(counts) <- paste0('Lane', lanes$index[[i]], '_Cell', seq_len(ncol(counts)))
      groups <- rep(c('0','1'), length.out=ncol(counts))
      samples <- rep(c('C1','C2','T1','T2'), each=100)
      marker <- if (lanes$index[[i]] == 1) 1:24 else 25:48
      counts[marker, groups == '1'] <- counts[marker, groups == '1'] + 8
      counts[81:120, samples %in% c('T1','T2')] <- counts[81:120, samples %in% c('T1','T2')] + 6
      object <- CreateSeuratObject(counts=Matrix(counts, sparse=TRUE))
      object <- NormalizeData(object, verbose=FALSE)
      ${includePca ? `
      object <- FindVariableFeatures(object, nfeatures=120, verbose=FALSE)
      object <- ScaleData(object, features=VariableFeatures(object), verbose=FALSE)
      object <- RunPCA(object, features=VariableFeatures(object), npcs=15, verbose=FALSE)
      ` : ''}
      Idents(object) <- factor(groups, levels=c('0','1'))
      object$seurat_clusters <- Idents(object)
      object$sample_id <- samples
      dir.create(dirname(lanes$path[[i]]), recursive=TRUE, showWarnings=FALSE)
      saveRDS(list(global=object, raw=object), lanes$path[[i]], compress=FALSE)
    }
  `;
  compose(['exec', '-T', 'r', 'Rscript', '-e', expression]);
}

function createNativePipelineInput() {
  const source = path.join(root, 'data', 'pbmc3k', 'filtered_gene_bc_matrices', 'hg19');
  const destination = path.join(tempRoot, 'pbmc3k-filtered-feature-bc-matrix.h5');
  if (!fs.existsSync(source)) {
    throw new Error('Native Seurat browser acceptance requires the checked-out PBMC3k MTX tutorial fixture.');
  }
  const converted = spawnSync('Rscript', [
    path.join(root, 'scripts', 'make_pbmc3k_h5.R'), source, destination,
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (converted.status !== 0 || !fs.existsSync(destination)) {
    throw new Error(`Native Seurat HDF5 fixture conversion failed: ${converted.stderr || converted.stdout || converted.status}`);
  }
  return destination;
}

function emptyStateCounts(cleanupEvidence) {
  return Object.fromEntries(Object.entries(cleanupEvidence || {}).map(([slot, value]) => [
    slot,
    Array.isArray(value?.activeSessionKeys) ? value.activeSessionKeys.length : null,
  ]));
}

function sanitizeLaneState(stateEvidence) {
  return Object.values(stateEvidence || {}).map((value) => ({
    activeKeyCount: Number.isInteger(value.observedActiveSessionKeyCount)
      ? value.observedActiveSessionKeyCount : null,
    ownKeyOnly: value.observedHasGlobalObject === true
      && value.observedActiveSessionKeyCount === 1
      && value.observedOwnKeyPresent === true
      && value.observedForeignKeyCount === 0,
  }));
}

function sanitizeCleanupEvidence(cleanupEvidence) {
  const counts = Object.values(emptyStateCounts(cleanupEvidence));
  return {
    lanesChecked: counts.length,
    allLanesEmpty: counts.length > 0 && counts.every(count => count === 0),
  };
}

function sanitizedPrivateComputeReport(evidence, sameProjectEvidence, scientificEvidence, collaborationEvidence) {
  const initialRunningIds = new Set(evidence.overlap.runningJobIds);
  const runtimeIds = Object.values(evidence.overlap.runtimeIds || {});

  return {
    schema: 'traceomics.private-compute-acceptance',
    version: 2,
    completedAt: new Date().toISOString(),
    topology: {
      isolatedLaneCount: evidence.overlap.slots.length,
      distinctRuntimeIdentities: runtimeIds.length === 2 && new Set(runtimeIds).size === 2,
      singleFlightPerLane: true,
    },
    concurrency: {
      observedAt: evidence.overlap.observedAt,
      runningCount: evidence.overlap.runningJobIds.length,
      queuedCount: 1,
      laneState: sanitizeLaneState(evidence.overlap.stateEvidence),
      jobs: evidence.jobs.map((job, index) => ({
        label: `job-${index + 1}`,
        initiallyRunning: initialRunningIds.has(job.id),
        initiallyQueued: job.id === evidence.overlap.queuedJobId,
        status: job.status,
        ranOnIsolatedLane: /^pool-(?:2|3):/.test(String(job.workerId || '')),
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
      })),
      artifactIsolation: {
        verifiedArtifactCount: evidence.markerArtifacts.length,
        distinctOwningProjects: new Set(evidence.markerArtifacts.map((artifact) => artifact.projectId)).size,
        projectPrefixesAndChecksumsVerified: true,
      },
      postBatchState: sanitizeCleanupEvidence(evidence.cleanupEvidence),
    },
    sameProjectConcurrency: {
      analystCount: sameProjectEvidence.analystCount,
      sharedStartingCheckpoint: sameProjectEvidence.sharedSourceVerified === true,
      privateForkOwnership: sameProjectEvidence.privateForkOwnershipVerified === true,
      distinctOutputKeys: sameProjectEvidence.distinctOutputKeysVerified === true,
      jobsCompleted: sameProjectEvidence.jobs.every((job) => job.status === 'completed'),
      laneState: sameProjectEvidence.overlap.stateEvidence.map((value) => ({
        activeKeyCount: value.observedActiveSessionKeyCount,
        ownKeyOnly: value.observedHasGlobalObject === true
          && value.observedActiveSessionKeyCount === 1
          && value.observedOwnKeyPresent === true
          && value.observedForeignKeyCount === 0,
      })),
      postBatchState: sanitizeCleanupEvidence(sameProjectEvidence.cleanupEvidence),
    },
    scientific: {
      completedJobCount: scientificEvidence.jobs.filter((job) => job.status === 'completed').length,
      artifactTypes: scientificEvidence.artifactTypes,
      aggregateOnlyExplorationRecipes: 3,
      privateFilesVerified: scientificEvidence.privateEvidence.map((item) => item.kind),
      replicateAwarePseudobulkVerified: true,
      deploymentEnrichmentPackagesVerified: true,
      deploymentCellChatPackageVerified: true,
      postBatchState: sanitizeCleanupEvidence(scientificEvidence.cleanupEvidence),
    },
    collaboration: {
      branchConflict: {
        success: collaborationEvidence.branchConflict.success,
        conflict: collaborationEvidence.branchConflict.conflict,
      },
      staleReviewRejected: collaborationEvidence.staleReviewRejected,
      canonicalVersion: collaborationEvidence.canonicalVersion,
      controlledDownloads: collaborationEvidence.downloadedTables.map((table) => ({
        artifactType: table.artifactType,
        checksumVerified: true,
        sizeBytes: table.sizeBytes,
      })),
      reproducibilityManifest: {
        exportedAnalysisAvailable: Boolean(collaborationEvidence.manifest.exportedAnalysisObjectId),
        lineageObjects: collaborationEvidence.manifest.lineageObjects,
        jobs: collaborationEvidence.manifest.jobs,
        artifacts: collaborationEvidence.manifest.artifacts,
        sampleBindings: collaborationEvidence.manifest.sampleBindings,
      },
      audit: collaborationEvidence.audit,
    },
    diagnostics: {
      rawRuntimeIdentifiersRetained: false,
      rawRStateKeysRetained: false,
      rawProjectOrUserIdentifiersRetained: false,
    },
  };
}

function writePrivateComputeReport(report) {
  const stamp = report.completedAt.replace(/[:.]/g, '-');
  const runDirectory = path.join(acceptanceRoot, `private-compute-${stamp}`);
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.writeFileSync(path.join(runDirectory, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  return runDirectory;
}

async function main() {
  let keep = process.env.KEEP_ACCEPTANCE_STACK === 'true';
  try {
    console.log(`[private-compute] project=${project} webPort=${webPort}`);
    compose(['build', 'web', 'r']);
    console.log('[private-compute] images built');
    compose(['up', '-d', '--wait', '--wait-timeout', '240']);
    const seeded = inner('seed');
    createCheckpoints(seeded, { includePca: nativeUiAcceptance });
    if (nativeUiAcceptance) {
      const pipelineInputPath = createNativePipelineInput();
      inner('register-checkpoints', seeded);
      const { runNativeUiAcceptance } = require('./verify-native-ui-flow');
      const result = await runNativeUiAcceptance({
        origin: `http://127.0.0.1:${webPort}`,
        lanes: seeded.lanes,
        pipelineInputPath,
        observeConcurrent: jobs => inner('native-observe', { jobs }),
      });
      console.log('[private-compute-ui] PASS real browser Seurat pipeline/UMAP/exploration/CellChat and two isolated native Electron DEG workflows');
      console.log(JSON.stringify({
        artifactDirectory: result.runDirectory,
        overlap: result.manifest.overlap,
      }, null, 2));
    } else {
      const launched = inner('launch', seeded);
      const evidence = inner('observe', launched);
      console.log('[private-compute] PASS two isolated R lanes overlapped while a third job queued');
      console.log(JSON.stringify(evidence, null, 2));
      const sameProjectJobs = inner('same-project-launch', seeded);
      const sameProjectEvidence = inner('same-project-observe', sameProjectJobs);
      console.log('[private-compute] PASS two analysts forked one shared checkpoint and ran concurrent private jobs in one project');
      console.log(JSON.stringify(sameProjectEvidence, null, 2));
      const scientificJobs = inner('scientific-launch', seeded);
      const scientificEvidence = inner('scientific-observe', scientificJobs);
      console.log('[private-compute] PASS exploratory recipes, replicate-aware pseudobulk, enrichment, and CellChat ran in real deployment R');
      console.log(JSON.stringify(scientificEvidence, null, 2));
      const collaborationEvidence = inner('collaboration-acceptance', seeded);
      console.log('[private-compute] PASS integrated multi-user branches, review conflicts, controlled exports, and immutable audit');
      console.log(JSON.stringify(collaborationEvidence, null, 2));
      const report = sanitizedPrivateComputeReport(
        evidence, sameProjectEvidence, scientificEvidence, collaborationEvidence
      );
      const runDirectory = writePrivateComputeReport(report);
      console.log(`[private-compute] retained sanitized evidence at ${runDirectory}`);
    }
  } catch (error) {
    keep = keep || process.env.KEEP_FAILED_ACCEPTANCE_STACK === 'true';
    try { compose(['ps', '--all']); } catch { /* best effort */ }
    try { compose(['logs', '--no-color', '--tail', '80']); } catch { /* best effort */ }
    throw error;
  } finally {
    if (keep) {
      console.log(`[private-compute] preserved project ${project}`);
    } else {
      try { compose(['down', '--volumes', '--remove-orphans']); } catch { /* best effort */ }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[private-compute] FAIL ${error.stack || error.message}`);
  process.exitCode = 1;
});
