import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_IMPORT_SCHEMA,
  canonicalArtifactImportRequest,
} from '../shared/artifactImport.mjs';
import {
  normalizeAnalysisLocalIntake,
  analysisLocalIntakeAttachmentRequest,
} from '../shared/analysisLocalIntake.mjs';
import { canonicalAnalysisAttachmentContent } from '../shared/analysisAttachment.mjs';

const { createAnalysisLocalIntakeService } = require('./analysisLocalIntakes');
const projectId = 'proj_' + 'a'.repeat(24);
const analysisId = 'ra_' + 'b'.repeat(24);
const serviceId = 'svc_' + 'c'.repeat(32);
const userId = 7;
const hash = (text) => createHash('sha256').update(text).digest('hex');

function fixture() {
  const requestId = '00000000-0000-4000-8000-000000000001';
  const recipe = normalizeAnalysisLocalIntake({
    requestId,
    serviceId,
    importRequest: {
      schema: ARTIFACT_IMPORT_SCHEMA,
      projectId,
      ownerUserId: userId,
      requestId,
      originalFilename: 'comparison.csv',
      name: 'Comparison',
      artifactType: 'auto',
      previousVersionId: null,
      sha256: 'd'.repeat(64),
      sizeBytes: 12,
    },
    attachment: {
      requestId: '00000000-0000-4000-8000-000000000002',
      action: 'create',
      attachmentId: null,
      expectedHeadRevisionId: null,
      caption: 'Treatment comparison',
      suppliedOrigin: {},
    },
  });
  const imported = {
    request_id: requestId,
    request_sha256: hash(canonicalArtifactImportRequest(recipe.importRequest)),
    request_json: recipe.importRequest,
    checksum_sha256: recipe.importRequest.sha256,
    size_bytes: 12,
    version_id: 'av_' + 'e'.repeat(24),
    previous_version_id: null,
  };
  const request = analysisLocalIntakeAttachmentRequest(recipe, {
    versionId: imported.version_id,
    sha256: imported.checksum_sha256,
    sizeBytes: 12,
    previousVersionId: null,
  });
  const attached = {
    request_id: recipe.attachment.requestId,
    action: 'create',
    expected_head_revision_id: null,
    source_owner_user_id: userId,
    reference_json: request.reference,
    caption: request.caption,
    supplied_origin_json: request.suppliedOrigin,
    request_sha256: hash(canonicalAnalysisAttachmentContent(request)),
  };
  return {
    row: {
      request_id: requestId,
      attachment_request_id: recipe.attachment.requestId,
      recipe_json: recipe,
      request_sha256: 'f'.repeat(64),
      created_at: '2026-10-08T01:00:00.000Z',
    },
    imported,
    attached,
  };
}

function serviceFor({ row, imported, attached }, queryError) {
  const client = {
    async query(sql) {
      if (sql.includes('service_execution_identity')) return { rows: [{ service_id: serviceId }] };
      if (sql.includes('research_analysis_intakes')) return { rows: [row] };
      if (queryError) throw queryError;
      if (sql.includes('managed_artifact_import_receipts'))
        return { rows: imported ? [imported] : [] };
      if (sql.includes('research_analysis_attachment_revisions'))
        return { rows: attached ? [attached] : [] };
      throw new Error('Unexpected reconciliation query');
    },
  };
  const context = {
    member: { role: 'analyst' },
    analysis: { status: 'active' },
    user: {},
  };
  return createAnalysisLocalIntakeService({
    database: client,
    provider: {},
    writable: () => true,
    transaction: (_userId, _projectId, _analysisId, action) => action(client, context),
  });
}

const list = (service) => service.listLocalIntakes(userId, projectId, analysisId);

describe('local intake reconciliation', () => {
  it('keeps missing receipts unconfirmed and accepts only matching import and attachment receipts', async () => {
    const data = fixture();
    const pending = await list(serviceFor({ ...data, imported: null, attached: null }));
    expect(pending.items[0]).toMatchObject({
      importStatus: 'unconfirmed',
      attachmentStatus: 'unconfirmed',
    });
    const accepted = await list(serviceFor(data));
    expect(accepted.items[0]).toMatchObject({
      importStatus: 'accepted',
      attachmentStatus: 'accepted',
    });
  });

  it('reports malformed or mismatched receipts as conflicts without adopting them', async () => {
    const data = fixture();
    data.imported.request_json = { ...data.imported.request_json, extra: true };
    expect((await list(serviceFor(data))).items[0]).toMatchObject({
      importStatus: 'conflict',
      attachmentStatus: 'conflict',
    });
    const attachmentData = fixture();
    attachmentData.attached.reference_json = {
      ...attachmentData.attached.reference_json,
      sha256: 'wrong',
    };
    expect((await list(serviceFor(attachmentData))).items[0]).toMatchObject({
      importStatus: 'accepted',
      attachmentStatus: 'conflict',
    });
    const changed = fixture();
    changed.imported.checksum_sha256 = '0'.repeat(64);
    expect((await list(serviceFor(changed))).items[0].importStatus).toBe('conflict');
  });

  it('surfaces unexpected faults while reading either receipt instead of reporting a conflict', async () => {
    for (const property of ['imported', 'attached']) {
      const data = fixture();
      const fault = new TypeError('Receipt adapter failed');
      const key = property === 'imported' ? 'request_json' : 'reference_json';
      Object.defineProperty(data[property], key, {
        get() {
          throw fault;
        },
      });
      await expect(list(serviceFor(data))).rejects.toBe(fault);
    }
  });

  it('surfaces database faults instead of presenting a missing admission', async () => {
    const fault = Object.assign(new Error('Database connection lost'), {
      code: '08006',
    });
    await expect(list(serviceFor(fixture(), fault))).rejects.toBe(fault);
  });
});
