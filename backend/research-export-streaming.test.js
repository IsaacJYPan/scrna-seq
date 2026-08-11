import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-export-streaming-'));
const storageRoot = path.join(testRoot, 'data');
const previousStorageRoot = process.env.STORAGE_ROOT;
const previousVaultRoot = process.env.VAULT_ROOT;
process.env.STORAGE_ROOT = storageRoot;
process.env.VAULT_ROOT = path.join(testRoot, 'vault');

const config = require('./config');
const db = require('./pgDatabase');
const projectAudit = require('./projectAudit');
const researchExports = require('./researchExports');
const storage = require('./storage');
const { startServer, createUserWithToken } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();
const provider = storage.createLocalStorageProvider({ root: storageRoot });
let server;

beforeAll(async () => {
  if (CONFIGURED) server = await startServer();
});

beforeEach(async () => {
  if (CONFIGURED) await db.resetSchemaForTests();
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (CONFIGURED) await db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
  if (previousStorageRoot === undefined) delete process.env.STORAGE_ROOT;
  else process.env.STORAGE_ROOT = previousStorageRoot;
  if (previousVaultRoot === undefined) delete process.env.VAULT_ROOT;
  else process.env.VAULT_ROOT = previousVaultRoot;
});

describe.skipIf(!CONFIGURED)('controlled artifact streaming', () => {
  it('streams every allowlisted artifact type with verified bytes and safe headers', async () => {
    const owner = await createUserWithToken({
      email: 'export-owner@example.com',
      displayName: 'Export Owner',
    });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Export Lab' });
    const project = await db.createProjectForUser(owner.user.id, {
      organizationId: organization.id,
      name: 'Export Study',
    });
    const object = await db.createProjectAnalysisObject(owner.user.id, project.id, {
      objectType: 'seurat',
      displayName: 'Export source',
    });
    const job = await db.createProjectJob(owner.user.id, project.id, {
      jobType: 'r.object.inspect',
      analysisObjectId: object.id,
      parameters: {},
    });
    const expectedTypes = [...researchExports.DOWNLOADABLE_ARTIFACT_TYPES].sort();
    const streamedTypes = [];

    for (const [index, artifactType] of expectedTypes.entries()) {
      const isBundle = artifactType === 'expert_r_bundle';
      const bytes = Buffer.from(
        isBundle ? `bundle-${artifactType}-${index}` : `feature,value\n${artifactType},${index}\n`,
        'utf8'
      );
      const source = path.join(testRoot, `source-${index}`);
      fs.writeFileSync(source, bytes, { flag: 'wx', mode: 0o600 });
      const filename = isBundle ? 'result.tar.gz' : 'result.csv';
      const key = storage.projectStorageFileKey(
        project.id, 'artifacts', job.id, `${index}-${filename}`
      );
      const stored = await provider.putFileFromPath(source, key);
      const artifact = await db.createArtifact(job, {
        artifactType,
        storageKind: 'local_internal',
        storageUri: stored.key,
        checksumSha256: stored.checksumSha256,
        sizeBytes: stored.sizeBytes,
        status: 'available',
      });

      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/projects/${project.id}/artifacts/${artifact.id}/download`,
        {
          headers: {
            Cookie: `${config.sessionCookieName()}=${encodeURIComponent(owner.token)}`,
          },
        }
      );
      const downloaded = Buffer.from(await response.arrayBuffer());

      expect(response.status, artifactType).toBe(200);
      expect(downloaded, artifactType).toEqual(bytes);
      expect(response.headers.get('content-length'), artifactType).toBe(String(bytes.length));
      expect(response.headers.get('content-type'), artifactType).toMatch(
        isBundle ? /^application\/gzip\b/ : /^text\/csv\b/
      );
      expect(response.headers.get('cache-control'), artifactType).toBe('private, no-store');
      expect(response.headers.get('content-disposition'), artifactType).toBe(
        `attachment; filename="${artifactType}-${artifact.id}.${isBundle ? 'tar.gz' : 'csv'}"`
      );
      expect(response.headers.get('content-disposition'), artifactType).not.toMatch(/[\\/]|storage|projects/i);
      streamedTypes.push(artifactType);
    }

    expect(streamedTypes.sort()).toEqual(expectedTypes);
    const events = await projectAudit.listEvents(owner.user.id, project.id, { limit: 100 });
    const downloadedEvents = events.filter((event) => event.action === 'artifact.downloaded');
    expect(downloadedEvents).toHaveLength(expectedTypes.length);
    expect(downloadedEvents.map((event) => event.details.artifactType).sort()).toEqual(expectedTypes);
  });
});
