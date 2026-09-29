'use strict';

const config = require('./config');
const HEAVY_TYPES = Object.freeze([
  'pbmc.pipeline.v1', 'seurat.pipeline.v1', 'seurat.multisample.v1', 'spatial.seurat.v1',
  'deg.find_markers.v1', 'enrichment.gsea.v1', 'cellchat.infer.v1',
  'explore.summarize.v1', 'condition.pseudobulk_de.v1',
]);

// Serialize the quota check and insertion, including retries. A route-level
// count alone races when two guests submit at the same time.
async function admitDemoJob(pool, owner, jobType, insert) {
  if (!config.demoMode() || !HEAVY_TYPES.includes(jobType)) return insert(null);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [0x5343524e, 530]);
    const guest = await client.query('SELECT is_demo_guest FROM users WHERE id = $1', [Number(owner)]);
    if (guest.rows[0]?.is_demo_guest) {
      const { rows } = await client.query(`SELECT
        COUNT(*) FILTER (WHERE owner_user_id = $1)::int AS guest_active,
        COUNT(*)::int AS global_active
        FROM jobs job JOIN users owner ON owner.id = job.owner_user_id
        WHERE owner.is_demo_guest = TRUE AND job.status IN ('queued', 'running')
          AND job.job_type = ANY($2::text[])`, [Number(owner), HEAVY_TYPES]);
      if (Number(rows[0]?.guest_active) >= 1
          || Number(rows[0]?.global_active) >= config.demoMaxGlobalHeavyJobs()) {
        throw Object.assign(new Error('The public demo compute pool is currently full.'), { code: 'DEMO_COMPUTE_LIMIT' });
      }
    }
    const result = await insert(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { HEAVY_TYPES, admitDemoJob };
