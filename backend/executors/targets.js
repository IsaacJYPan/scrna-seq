'use strict';

// Compute targets visible to people and agents: the local worker, plus the
// Slurm cluster when configured. Slurm reachability is probed with `sinfo` and
// cached briefly so status reads do not open an SSH connection every time.

const { createSlurmExecutor } = require('./slurm');

function createTargetDirectory({ db, ttlMs = Number(process.env.COMPUTE_TARGET_STATUS_TTL_MS) || 60000, executor } = {}) {
  let cached = null;

  async function list() {
    if (!cached || Date.now() - cached.at > ttlMs) {
      // Re-read the target configuration on each refresh.
      const slurm = executor || createSlurmExecutor({ db });
      cached = { at: Date.now(), slurm: await slurm.status() };
    }
    return {
      schema: 'traceomics.compute-targets.v1',
      checkedAt: new Date(cached.at).toISOString(),
      targets: [
        { name: 'local', kind: 'local', configured: true, available: true,
          description: 'The installation worker and R service.' },
        { ...cached.slurm, name: 'slurm',
          description: 'Slurm cluster through the configured login node.' },
      ],
    };
  }

  return { list };
}

module.exports = { createTargetDirectory };
