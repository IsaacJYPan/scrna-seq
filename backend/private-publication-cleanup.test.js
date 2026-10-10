import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

const db = require('./pgDatabase');
const { environmentFixture } = require('./_r-environment-test-utils');
const { generatePrivateKernelExportSource } = require('./privateKernelExports');
const storage = require('./storage');
const id = prefix => `${prefix}_${randomBytes(12).toString('hex')}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const savedMode = process.env.APP_DEPLOYMENT_MODE;

// These database-only fixtures represent retained historical publication
// evidence. They do not enable or dispatch private R in a public demo.
async function seedHistory(userId, projectId) {
  const kernelId = id('pk'), artifactId = id('af'), generation = hash(randomUUID());
  const { manifest, reference } = environmentFixture();
  const connection = await (await db.connect()).connect();
  const versions = [], publications = [], executions = [];
  try {
    await connection.query('BEGIN');
    await connection.query(`INSERT INTO private_r_kernels
      (id,project_id,owner_user_id,workspace_id,request_id,start_sha256,status,runtime_generation,
       environment_json,environment_manifest_json,inputs_json,next_order,expires_at,stopped_at)
      VALUES($1,$2,$3,'cleanup-fixture',$4,$5,'stopped',$6,$7,$8,'[]',2,NOW()+INTERVAL '1 hour',NOW())`,
    [kernelId, projectId, userId, randomUUID(), hash('cleanup input'), generation, reference, manifest]);
    for (let order = 1; order <= 2; order++) {
      const executionId = id('pex'), publicationId = id('pub'), versionId = id('av');
      const previousVersionId = versions.at(-1) || null;
      const source = generatePrivateKernelExportSource({ publicationId, generation, type: 'object', binding: 'obj' });
      const checksum = hash(`synthetic saved bytes ${order}`);
      const key = storage.projectStorageFileKey(projectId, 'artifacts', versionId, 'content.rds');
      const lineage = { schemaVersion: 1, kind: 'private-r-publication', kernelId, generation,
        sourceExecutionId: executionId, order, sourceSha256: hash(source), environment: reference,
        inputs: [], replay: { complete: false, issues: ['Synthetic database lifecycle fixture.'] } };
      await connection.query(`INSERT INTO private_r_executions
        (id,kernel_id,project_id,owner_user_id,request_id,kernel_generation,execution_order,status,
         source_code,source_sha256,started_at,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8,$9,NOW(),NOW())`,
      [executionId, kernelId, projectId, userId, randomUUID(), generation, order, source, hash(source)]);
      await connection.query(`INSERT INTO private_r_publications
        (id,kernel_id,project_id,owner_user_id,request_id,request_sha256,status,publication_type,name,
         binding_name,source_execution_id,kernel_generation,kernel_order,artifact_id,version_id,
         previous_version_id,storage_key,reserved_bytes,checksum_sha256,size_bytes,lineage_json,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,'completed','object',$7,'obj',$8,$9,$10,$11,$12,$13,$14,20971520,$15,24,$16,NOW())`,
      [publicationId, kernelId, projectId, userId, randomUUID(), hash(`save ${order}`), `Saved object ${order}`,
        executionId, generation, order, artifactId, versionId, previousVersionId, key, checksum, lineage]);
      await connection.query(`INSERT INTO managed_artifact_versions
        (id,artifact_id,project_id,owner_user_id,name,version_number,previous_version_id,artifact_type,
         format_json,mime_type,checksum_sha256,size_bytes,storage_key,source_publication_id,provenance_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,'object',$8,'application/octet-stream',$9,24,$10,$11,$12)`,
      [versionId, artifactId, projectId, userId, `Saved object ${order}`, order, previousVersionId,
        { id: 'org.r-project.rds', version: '1' }, checksum, key, publicationId, lineage]);
      versions.push(versionId); publications.push(publicationId); executions.push(executionId);
    }
    const auditId = id('audit');
    const replacementKernelId = id('pk'), restartId = id('prst'), restartRequestId = randomUUID();
    await connection.query(`INSERT INTO private_r_kernels
      (id,project_id,owner_user_id,workspace_id,request_id,start_sha256,status,runtime_generation,
       environment_json,environment_manifest_json,inputs_json,expires_at,restarted_from_kernel_id,stopped_at)
      VALUES($1,$2,$3,'cleanup-fixture',$4,$5,'stopped',$6,$7,$8,'[]',NOW()+INTERVAL '1 hour',$9,NOW())`,
    [replacementKernelId,projectId,userId,restartRequestId,hash('replacement snapshot'),hash(randomUUID()),reference,manifest,kernelId]);
    await connection.query(`INSERT INTO private_r_kernel_restarts
      (id,kernel_id,project_id,owner_user_id,request_id,request_sha256,kernel_generation,replacement_kernel_id,status,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'completed',NOW())`,
    [restartId,kernelId,projectId,userId,restartRequestId,hash('restart snapshot'),generation,replacementKernelId]);
    await connection.query(`INSERT INTO project_audit_events
      (id,project_id,actor_user_id,action,target_type,target_id)
      VALUES($1,$2,$3,'analysis.created','artifact',$4)`, [auditId, projectId, userId, artifactId]);
    await connection.query('COMMIT');
    return { kernelId, replacementKernelId, restartId, artifactId, versions, publications, executions, auditId };
  } catch (error) {
    await connection.query('ROLLBACK'); throw error;
  } finally { connection.release(); }
}

async function seedOwner() {
  const owner = await db.createUser(`cleanup-owner-${randomUUID()}@example.test`, 'password123', 'Research owner');
  const organization = await db.createOrganizationForUser(owner.id, { name: 'Retained research lab' });
  const project = await db.createProjectForUser(owner.id, { organizationId: organization.id, name: 'Retained study' });
  return { owner, organization, project, history: await seedHistory(owner.id, project.id) };
}
async function seedGuest() {
  const guest = await db.createDemoGuest(`cleanup-guest-${randomUUID()}@example.test`, 'password123', new Date(Date.now() + 3600000));
  return { ...guest, history: await seedHistory(guest.user.id, guest.project.id) };
}
async function historySnapshot(projectId) {
  const snapshot = {};
  for (const table of ['private_r_kernels', 'private_r_kernel_restarts', 'private_r_executions', 'private_r_publications', 'managed_artifact_versions', 'project_audit_events']) {
    snapshot[table] = (await db.query(`SELECT row_to_json(record) AS record FROM ${table} record WHERE project_id=$1 ORDER BY id`, [projectId])).rows.map(row => row.record);
  }
  return snapshot;
}

describe.skipIf(!process.env.DATABASE_URL)('expired demo publication lifecycle cleanup', () => {
  beforeEach(async () => { process.env.APP_DEPLOYMENT_MODE = 'demo'; await db.resetSchemaForTests(); });
  afterAll(async () => { if (savedMode === undefined) delete process.env.APP_DEPLOYMENT_MODE; else process.env.APP_DEPLOYMENT_MODE = savedMode; await db.close(); });

  it('upgrades legacy publication bounds and reapplies the current schema without losing retained history', async () => {
    const retained = await seedOwner(), before = await historySnapshot(retained.project.id);
    await db.query('ALTER TABLE private_r_publications DROP CONSTRAINT private_r_publications_reserved_bytes_check');
    await db.query('ALTER TABLE private_r_publications ADD CONSTRAINT private_r_publications_reserved_bytes_check CHECK (reserved_bytes BETWEEN 1 AND 20971520)');
    await db.query('ALTER TABLE private_r_publications DROP CONSTRAINT private_r_publications_size_bytes_check');
    await db.query('ALTER TABLE private_r_publications ADD CONSTRAINT private_r_publications_size_bytes_check CHECK (size_bytes BETWEEN 1 AND 20971520)');
    await db.initSchema({ force: true }); await db.initSchema({ force: true });
    expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261016);
    const constraints = (await db.query(`SELECT condeferrable,condeferred FROM pg_constraint
      WHERE conrelid='private_r_publications'::regclass AND confrelid='managed_artifact_versions'::regclass AND contype='f'`)).rows;
    expect(constraints).toEqual([{ condeferrable: true, condeferred: true }]);
    expect((await db.query("SELECT condeferrable,condeferred FROM pg_constraint WHERE conname='private_r_kernel_restart_parent_fk'")).rows).toEqual([{condeferrable:true,condeferred:true}]);
    expect(await historySnapshot(retained.project.id)).toEqual(before);
    const bounds = (await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='private_r_publications'::regclass AND conname IN ('private_r_publications_reserved_bytes_check','private_r_publications_size_bytes_check') ORDER BY conname")).rows;
    expect(bounds).toHaveLength(2);
    expect(bounds.every(row => row.definition.includes('68719476736'))).toBe(true);
    expect(bounds[1].definition).toContain('size_bytes <= reserved_bytes');
  });

  it('deletes an expired guest’s publication/version FK cycle atomically while preserving an unrelated owner and project', async () => {
    const retained = await seedOwner(), guest = await seedGuest();
    const before = await historySnapshot(retained.project.id);
    const links = (await db.query(`SELECT version.id,version.previous_version_id,version.source_publication_id,
      publication.previous_version_id AS publication_previous FROM managed_artifact_versions version
      JOIN private_r_publications publication ON publication.id=version.source_publication_id
      WHERE version.project_id=$1 ORDER BY version.version_number`, [guest.project.id])).rows;
    expect(links).toEqual([
      { id: guest.history.versions[0], previous_version_id: null, source_publication_id: guest.history.publications[0], publication_previous: null },
      { id: guest.history.versions[1], previous_version_id: guest.history.versions[0], source_publication_id: guest.history.publications[1], publication_previous: guest.history.versions[0] },
    ]);
    await db.query("UPDATE users SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [guest.user.id]);
    expect(await db.deleteExpiredDemoGuest(guest.user.id)).toBe(true);
    for (const rows of Object.values(await historySnapshot(guest.project.id))) expect(rows).toEqual([]);
    expect((await db.query('SELECT id FROM users WHERE id=$1', [guest.user.id])).rows).toEqual([]);
    expect((await db.query('SELECT id FROM projects WHERE id=$1', [guest.project.id])).rows).toEqual([]);
    expect((await db.query('SELECT id FROM organizations WHERE id=$1', [guest.organization.id])).rows).toEqual([]);
    expect(await historySnapshot(retained.project.id)).toEqual(before);
    expect((await db.query('SELECT id FROM users WHERE id=$1', [retained.owner.id])).rows).toHaveLength(1);
    expect((await db.query('SELECT id FROM projects WHERE id=$1', [retained.project.id])).rows).toHaveLength(1);
    expect((await db.query('SELECT id FROM organizations WHERE id=$1', [retained.organization.id])).rows).toHaveLength(1);
    // The deliberately permitted audit deletion must remain transaction-local.
    await expect(db.query('DELETE FROM project_audit_events WHERE id=$1', [retained.history.auditId])).rejects.toMatchObject({ code: '55000' });
    expect(await db.deleteExpiredDemoGuest(guest.user.id)).toBe(false);
  });

  it('does not clean an unexpired guest or a regular owner even when the owner has an expired timestamp', async () => {
    const retained = await seedOwner(), guest = await seedGuest();
    const ownerBefore = await historySnapshot(retained.project.id), guestBefore = await historySnapshot(guest.project.id);
    await db.query("UPDATE users SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [retained.owner.id]);
    expect(await db.deleteExpiredDemoGuest(guest.user.id)).toBe(false);
    expect(await db.deleteExpiredDemoGuest(retained.owner.id)).toBe(false);
    expect(await historySnapshot(guest.project.id)).toEqual(guestBefore);
    expect(await historySnapshot(retained.project.id)).toEqual(ownerBefore);
  });
});
