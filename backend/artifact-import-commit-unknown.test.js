// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createArtifactVersionService } = require('./artifactVersions');
const configured = Boolean(process.env.DATABASE_URL);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let directory, provider, user, organization, project;

// No bootstrap or global reset: each case owns only its account/project/files.
describe.skipIf(!configured)('multipart artifact import with uncertain commit acknowledgement', () => {
  beforeAll(async () => {
    const databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1));
    if (!/(?:^|[_-])(test|ci)(?:$|[_-])/i.test(databaseName)) throw new Error('Use an explicitly named isolated test database.');
    await db.query('SELECT 1');
    directory = await mkdtemp(path.join(os.tmpdir(), 'artifact-commit-unknown-test-'));
    provider = storage.createLocalStorageProvider({ root: path.join(directory, 'storage') });
  });
  beforeEach(async () => {
    const nonce = crypto.randomBytes(12).toString('hex');
    user = await db.createUser(`artifact-commit-${nonce}@example.test`, `Retained-file-${nonce}`, 'Artifact commit researcher');
    organization = await db.createOrganizationForUser(user.id, { name: 'Artifact commit test lab' });
    project = await db.createProjectForUser(user.id, { organizationId: organization.id, name: 'Isolated artifact commit test' });
  });
  afterEach(async () => {
    // Direct fixture creation emits no audit events. Delete only these exact
    // rows, leaving other tests sharing the database untouched.
    if (project) {
      await db.query('DELETE FROM managed_artifact_versions WHERE project_id=$1 AND owner_user_id=$2', [project.id, user.id]);
      await db.query('DELETE FROM project_members WHERE project_id=$1', [project.id]);
      await db.query('DELETE FROM projects WHERE id=$1 AND created_by_user_id=$2', [project.id, user.id]);
    }
    if (organization) {
      await db.query('DELETE FROM organization_members WHERE organization_id=$1', [organization.id]);
      await db.query('DELETE FROM organizations WHERE id=$1 AND owner_user_id=$2', [organization.id, user.id]);
    }
    if (user) await db.query('DELETE FROM users WHERE id=$1', [user.id]);
    project = organization = user = null;
  });
  afterAll(async () => {
    if (!configured) return;
    await db.close();
    if (directory) {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('artifact-commit-unknown-test-')) throw new Error('Refusing cleanup outside the owned artifact test directory.');
      await rm(resolved, { recursive: true, force: true });
    }
  });

  function faultedDatabase({ loseCommit = false, rejectInsert = false } = {}) {
    const lostAcknowledgement = Object.assign(new Error('The import transaction acknowledgement was lost.'), { code: 'ECONNRESET' });
    const insertFailure = Object.assign(new Error('The import insert was definitively rejected.'), { code: '23514' });
    const observation = { inserted: null, committed: false, commitFaults: 0 };
    return { observation, lostAcknowledgement, insertFailure, database: { ...db, connect: async () => {
      const pool = await db.connect();
      return { connect: async () => {
        const connection = await pool.connect();
        return {
          query: async (text, values) => {
            const sql = typeof text === 'string' ? text : text.text;
            const inserting = /\bINSERT\s+INTO\s+managed_artifact_versions\b/i.test(sql);
            if (inserting && rejectInsert) throw insertFailure;
            const result = await connection.query(text, values);
            if (inserting) observation.inserted = result.rows[0];
            if (/^\s*COMMIT\s*;?\s*$/i.test(sql) && observation.inserted && loseCommit && !observation.commitFaults) {
              // PostgreSQL has really committed. Only the delivery of that
              // successful acknowledgement is faulted; no success is mocked.
              observation.committed = true; observation.commitFaults++;
              throw lostAcknowledgement;
            }
            return result;
          },
          release: () => connection.release(),
        };
      } };
    } } };
  }

  it('keeps exact managed bytes when PostgreSQL commits but the acknowledgement is lost', async () => {
    const bytes = Buffer.from('gene,score\nACTB,7\n'), source = path.join(directory, crypto.randomUUID() + '.csv');
    await writeFile(source, bytes);
    const fault = faultedDatabase({ loseCommit: true });
    const service = createArtifactVersionService(fault.database, provider);
    await expect(service.importFile(user.id, project.id, { path: source, originalFilename: 'outside-result.csv' })).rejects.toBe(fault.lostAcknowledgement);
    expect(fault.observation.committed).toBe(true); expect(fault.observation.commitFaults).toBe(1);
    const rows = (await db.query('SELECT * FROM managed_artifact_versions WHERE project_id=$1 AND owner_user_id=$2', [project.id, user.id])).rows;
    expect(rows).toHaveLength(1);
    const saved = rows[0];
    expect(saved.id).toBe(fault.observation.inserted.id);
    expect(saved.checksum_sha256).toBe(sha(bytes)); expect(Number(saved.size_bytes)).toBe(bytes.length);
    // A committed immutable record must never point at bytes removed by the
    // error cleanup path. This fails on cleanup based only on local ack state.
    await expect(readFile(provider.resolveKey(saved.storage_key))).resolves.toEqual(bytes);
    const retained = createArtifactVersionService(db, provider);
    expect((await retained.get(user.id, project.id, saved.id)).sha256).toBe(sha(bytes));
    expect((await retained.preview(user.id, project.id, saved.id)).preview.rows).toEqual([['ACTB', '7']]);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM managed_artifact_versions WHERE project_id=$1', [project.id])).rows[0].count).toBe(1);
  });

  it('still removes uncommitted owned bytes after a definitive insert rejection', async () => {
    const bytes = Buffer.from('gene,score\nACTB,8\n'), source = path.join(directory, crypto.randomUUID() + '.csv');
    await writeFile(source, bytes);
    let storedKey;
    const observedProvider = { ...provider, putFileFromPath: async (input, key) => { const result = await provider.putFileFromPath(input, key); storedKey = key; return result; } };
    const fault = faultedDatabase({ rejectInsert: true });
    const service = createArtifactVersionService(fault.database, observedProvider);
    await expect(service.importFile(user.id, project.id, { path: source, originalFilename: 'rejected.csv' })).rejects.toBe(fault.insertFailure);
    expect(storedKey).toBeTruthy(); expect(fault.observation.committed).toBe(false);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM managed_artifact_versions WHERE project_id=$1', [project.id])).rows[0].count).toBe(0);
    await expect(readFile(provider.resolveKey(storedKey))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
