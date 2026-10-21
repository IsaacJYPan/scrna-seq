'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { getServiceExecutionIdentity } = require('./executionTargets');
const { createArtifactVersionService } = require('./artifactVersions');
const contracts = Promise.all([
  import('../shared/analysisLocalIntake.mjs'),
  import('../shared/artifactImport.mjs'),
  import('../shared/analysisAttachment.mjs'),
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const time = (value) => new Date(value).toISOString();
const failure = (code, message, status = 400) =>
  Object.assign(new Error(message), { code, status });
const missing = () => {
  throw failure(
    'ANALYSIS_LOCAL_INTAKE_NOT_FOUND',
    'This import is not confirmed yet. Keep its file and check the same request again.',
    404
  );
};
const conflict = () => {
  throw failure(
    'ANALYSIS_LOCAL_INTAKE_REQUEST_CONFLICT',
    'This request belongs to another import. Recover that import before starting a new one.',
    409
  );
};

function acceptedImport(recipe, imported, schema) {
  const canonical = schema.canonicalArtifactImportRequest(recipe.importRequest);
  let captured;
  try {
    captured = schema.canonicalArtifactImportRequest(imported.request_json);
  } catch (error) {
    if (error?.code !== 'INVALID_ARTIFACT_IMPORT_RESPONSE') throw error;
    return null;
  }
  if (
    imported.request_sha256 !== digest(canonical) ||
    captured !== canonical ||
    imported.checksum_sha256 !== recipe.importRequest.sha256 ||
    Number(imported.size_bytes) !== recipe.importRequest.sizeBytes ||
    !/^av_[a-f0-9]{24}$/.test(imported.version_id) ||
    imported.previous_version_id !== null
  )
    return null;
  return {
    versionId: imported.version_id,
    sha256: imported.checksum_sha256,
    sizeBytes: Number(imported.size_bytes),
    previousVersionId: null,
  };
}

function matchesAttachment(recipe, acceptance, attached, userId, intakeSchema, attachmentSchema) {
  const expected = intakeSchema.analysisLocalIntakeAttachmentRequest(recipe, acceptance);
  const { action, attachmentId } = recipe.attachment;
  const canonical =
    action === 'correct'
      ? attachmentSchema.canonicalAnalysisAttachmentCorrection(attachmentId, expected)
      : attachmentSchema.canonicalAnalysisAttachmentContent(expected);
  const captured = {
    reference: attached.reference_json,
    caption: attached.caption,
    suppliedOrigin: attached.supplied_origin_json,
    ...(action === 'correct' ? { expectedHeadRevisionId: attached.expected_head_revision_id } : {}),
  };
  let actual;
  try {
    actual =
      action === 'correct'
        ? attachmentSchema.canonicalAnalysisAttachmentCorrection(attached.attachment_id, captured)
        : attachmentSchema.canonicalAnalysisAttachmentContent(captured);
  } catch (error) {
    if (error?.code !== 'INVALID_ANALYSIS_ATTACHMENT') throw error;
    return false;
  }
  return (
    attached.action === action &&
    (action === 'create'
      ? attached.expected_head_revision_id === null
      : attached.attachment_id === attachmentId) &&
    Number(attached.source_owner_user_id) === Number(userId) &&
    attached.request_sha256 === digest(canonical) &&
    actual === canonical
  );
}

function createAnalysisLocalIntakeService({
  database,
  provider,
  transaction,
  writable,
  attachmentResult,
  head,
  item,
}) {
  const artifacts = createArtifactVersionService(database, provider);
  async function identity(client) {
    const row = (
      await client.query('SELECT service_id FROM service_execution_identity WHERE singleton=TRUE')
    ).rows[0];
    return row?.service_id || (await getServiceExecutionIdentity(client)).id;
  }
  const flags = (context) => ({
    canContinue: writable(context),
    canUpload: writable(context),
    canAttach: writable(context),
  });
  function assertFresh(context) {
    if (!['owner', 'admin', 'analyst'].includes(context.member.role))
      throw failure('FORBIDDEN', 'Project write access is required to import a file.', 403);
    if (context.analysis.status !== 'active')
      throw failure('ANALYSIS_ARCHIVED', 'Restore this analysis to continue importing files.', 409);
    if (context.user.is_demo_guest || config.demoMode())
      throw failure('FORBIDDEN', 'File imports are disabled on this server.', 403);
  }
  async function observe(client, userId, projectId, analysisId, rows) {
    if (!rows.length) return [];
    // These reads deliberately do not acquire the upload advisory fence. An
    // absent receipt is unconfirmed; waiting on that fence while holding the
    // analysis/project read locks would invert the upload's lock order.
    const imports = (
      await client.query(
        `SELECT * FROM managed_artifact_import_receipts
      WHERE project_id=$1 AND owner_user_id=$2 AND request_id=ANY($3::uuid[])`,
        [projectId, userId, rows.map((row) => row.request_id)]
      )
    ).rows;
    const attachments = (
      await client.query(
        `SELECT * FROM research_analysis_attachment_revisions
      WHERE project_id=$1 AND analysis_id=$2 AND actor_user_id=$3 AND request_id=ANY($4::uuid[])`,
        [projectId, analysisId, userId, rows.map((row) => row.attachment_request_id)]
      )
    ).rows;
    const importById = new Map(imports.map((row) => [row.request_id, row]));
    const attachmentById = new Map(attachments.map((row) => [row.request_id, row]));
    const [schema, importSchema, attachmentSchema] = await contracts;
    return rows.map((row) => {
      const recipe = schema.normalizeAnalysisLocalIntake(row.recipe_json);
      const imported = importById.get(row.request_id);
      const attached = attachmentById.get(row.attachment_request_id);
      const acceptance = imported ? acceptedImport(recipe, imported, importSchema) : null;
      const importStatus = acceptance ? 'accepted' : imported ? 'conflict' : 'unconfirmed';
      let attachmentStatus = attached ? 'conflict' : 'unconfirmed';
      if (
        attached &&
        acceptance &&
        matchesAttachment(recipe, acceptance, attached, userId, schema, attachmentSchema)
      ) {
        attachmentStatus = 'accepted';
      }
      return {
        row,
        recipe,
        imported,
        attached,
        importStatus,
        attachmentStatus,
      };
    });
  }
  async function display(client, context, userId, projectId, analysisId, serviceId, row, replayed) {
    const observation = (await observe(client, userId, projectId, analysisId, [row]))[0];
    const allowed =
      ['owner', 'admin', 'analyst'].includes(context.member.role) &&
      !context.user.is_demo_guest &&
      !config.demoMode();
    return {
      serviceId,
      projectId,
      analysisId,
      ownerUserId: Number(userId),
      ...flags(context),
      requestId: row.request_id,
      requestSha256: row.request_sha256,
      recipe: observation.recipe,
      createdAt: time(row.created_at),
      replayed,
      importOutcome: {
        status: observation.importStatus,
        receipt:
          observation.importStatus === 'accepted'
            ? await artifacts.serializeImportReceipt(client, observation.imported, allowed)
            : null,
      },
      attachmentOutcome: {
        status: observation.attachmentStatus,
        receipt:
          observation.attachmentStatus === 'accepted'
            ? await attachmentResult(
                client,
                context,
                userId,
                projectId,
                analysisId,
                observation.attached,
                true
              )
            : null,
      },
    };
  }
  async function admitLocalIntake(userId, projectId, analysisId, input) {
    const [schema] = await contracts;
    const recipe = schema.normalizeAnalysisLocalIntake(input);
    const canonical = schema.canonicalAnalysisLocalIntake(analysisId, recipe),
      hash = digest(canonical);
    if (
      recipe.importRequest.projectId !== projectId ||
      recipe.importRequest.ownerUserId !== Number(userId)
    ) {
      throw failure(
        'INVALID_ANALYSIS_LOCAL_INTAKE',
        'Use the account and project where this import was started.'
      );
    }
    return transaction(
      userId,
      projectId,
      analysisId,
      async (client, context) => {
        const serviceId = await identity(client);
        if (serviceId !== recipe.serviceId)
          throw failure(
            'ANALYSIS_LOCAL_INTAKE_SERVICE_CHANGED',
            'Reconnect to the server where this import was started.',
            409
          );
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `analysis-local-intake:${projectId}:${userId}:${recipe.requestId}`,
        ]);
        const existing = (
          await client.query(
            'SELECT * FROM research_analysis_local_intakes WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3',
            [projectId, userId, recipe.requestId]
          )
        ).rows[0];
        if (existing) {
          if (
            existing.analysis_id !== analysisId ||
            existing.request_sha256 !== hash ||
            schema.canonicalAnalysisLocalIntake(analysisId, existing.recipe_json) !== canonical
          )
            conflict();
          return display(client, context, userId, projectId, analysisId, serviceId, existing, true);
        }
        assertFresh(context);
        if (
          (
            await client.query(
              'SELECT 1 FROM research_analysis_local_intakes WHERE project_id=$1 AND analysis_id=$2 AND owner_user_id=$3 AND attachment_request_id=$4',
              [projectId, analysisId, userId, recipe.attachment.requestId]
            )
          ).rowCount
        )
          conflict();
        const count = (
          await client.query(
            'SELECT COUNT(*)::int AS n FROM research_analysis_local_intakes WHERE project_id=$1 AND analysis_id=$2',
            [projectId, analysisId]
          )
        ).rows[0].n;
        if (count >= schema.ANALYSIS_LOCAL_INTAKE_LIMITS.recipes)
          throw failure(
            'ANALYSIS_LOCAL_INTAKE_LIMIT',
            'This analysis has reached its 2000-import limit. Existing imports are still available.',
            409
          );
        if (recipe.attachment.action === 'correct') {
          const current = await head(client, projectId, analysisId, recipe.attachment.attachmentId);
          if (current.head_revision_id !== recipe.attachment.expectedHeadRevisionId) {
            throw Object.assign(
              failure(
                'ANALYSIS_ATTACHMENT_HEAD_CONFLICT',
                'This attachment changed. Review its current revision before saving your correction.',
                409
              ),
              {
                attachment: await item(client, userId, projectId, current),
                submittedExpectedHeadRevisionId: recipe.attachment.expectedHeadRevisionId,
              }
            );
          }
        }
        const row = (
          await client.query(
            `INSERT INTO research_analysis_local_intakes
        (project_id,analysis_id,owner_user_id,request_id,attachment_request_id,service_id,request_sha256,recipe_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [
              projectId,
              analysisId,
              userId,
              recipe.requestId,
              recipe.attachment.requestId,
              serviceId,
              hash,
              recipe,
            ]
          )
        ).rows[0];
        return display(client, context, userId, projectId, analysisId, serviceId, row, false);
      },
      true
    );
  }
  async function getLocalIntake(userId, projectId, analysisId, requestId) {
    if (typeof requestId !== 'string' || !UUID.test(requestId)) missing();
    return transaction(
      userId,
      projectId,
      analysisId,
      async (client, context) => {
        const row = (
          await client.query(
            'SELECT * FROM research_analysis_local_intakes WHERE project_id=$1 AND analysis_id=$2 AND owner_user_id=$3 AND request_id=$4',
            [projectId, analysisId, userId, requestId.toLowerCase()]
          )
        ).rows[0];
        if (!row) missing();
        const serviceId = await identity(client);
        if (row.service_id !== serviceId)
          throw failure(
            'ANALYSIS_LOCAL_INTAKE_SERVICE_CHANGED',
            'Reconnect to the server where this import was started.',
            409
          );
        return display(client, context, userId, projectId, analysisId, serviceId, row, true);
      },
      true
    );
  }
  async function listLocalIntakes(userId, projectId, analysisId, options = {}) {
    const [schema] = await contracts;
    const limits = schema.ANALYSIS_LOCAL_INTAKE_LIMITS;
    if (Object.keys(options).some((key) => !['limit', 'cursor'].includes(key)))
      throw failure(
        'INVALID_ANALYSIS_LOCAL_INTAKE_PAGE',
        'Use only limit and cursor to page through imports.'
      );
    const limit = options.limit === undefined ? limits.page : Number(options.limit);
    let cursor = null;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.page)
      throw failure(
        'INVALID_ANALYSIS_LOCAL_INTAKE_PAGE',
        'Choose an intake page size between 1 and 30.'
      );
    if (options.cursor !== undefined) {
      const invalidCursor = () =>
        failure(
          'INVALID_ANALYSIS_LOCAL_INTAKE_PAGE',
          'This import page is invalid. Reload the list.'
        );
      if (
        typeof options.cursor !== 'string' ||
        !options.cursor ||
        options.cursor.length > limits.cursor ||
        !/^[A-Za-z0-9_-]+$/.test(options.cursor)
      )
        throw invalidCursor();
      try {
        cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw invalidCursor();
      }
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 3 ||
        cursor[0] !== analysisId ||
        typeof cursor[1] !== 'string' ||
        !Number.isFinite(Date.parse(cursor[1])) ||
        new Date(cursor[1]).toISOString() !== cursor[1] ||
        typeof cursor[2] !== 'string' ||
        !UUID.test(cursor[2])
      )
        throw invalidCursor();
    }
    return transaction(
      userId,
      projectId,
      analysisId,
      async (client, context) => {
        const serviceId = await identity(client);
        const rows = (
          await client.query(
            `SELECT * FROM research_analysis_local_intakes WHERE project_id=$1 AND analysis_id=$2 AND owner_user_id=$3 AND service_id=$4
        AND ($5::timestamptz IS NULL OR (date_trunc('milliseconds',created_at),request_id)<($5::timestamptz,$6::uuid))
        ORDER BY date_trunc('milliseconds',created_at) DESC,request_id DESC LIMIT $7`,
            [
              projectId,
              analysisId,
              userId,
              serviceId,
              cursor?.[1] || null,
              cursor?.[2] || null,
              limit + 1,
            ]
          )
        ).rows;
        const selected = rows.slice(0, limit),
          observations = await observe(client, userId, projectId, analysisId, selected),
          last = selected.at(-1);
        return {
          serviceId,
          projectId,
          analysisId,
          ownerUserId: Number(userId),
          ...flags(context),
          items: observations.map((observation) => {
            const { row, recipe, importStatus, attachmentStatus } = observation;
            return {
              requestId: row.request_id,
              requestSha256: row.request_sha256,
              createdAt: time(row.created_at),
              originalFilename: recipe.importRequest.originalFilename,
              name: recipe.importRequest.name,
              caption: recipe.attachment.caption,
              action: recipe.attachment.action,
              attachmentId: recipe.attachment.attachmentId,
              expectedHeadRevisionId: recipe.attachment.expectedHeadRevisionId,
              importStatus,
              attachmentStatus,
            };
          }),
          nextCursor:
            rows.length > limit
              ? Buffer.from(
                  JSON.stringify([analysisId, time(last.created_at), last.request_id])
                ).toString('base64url')
              : null,
        };
      },
      true
    );
  }
  return { admitLocalIntake, getLocalIntake, listLocalIntakes };
}

module.exports = { createAnalysisLocalIntakeService };
