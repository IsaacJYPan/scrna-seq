'use strict';

// The analysis ledger (shared/analysisLedger.mjs): an agent's decisions,
// cluster labels, findings, issues and checklist answers, each citing the
// run outputs that support it, and the audit a reviewer reads first.
//
// Entries are append-only. Every evidence reference is checked against the
// agent's own runs when the entry is written: a sandbox run must have
// finished with outputs and list the cited file (whose SHA-256 is recorded),
// and a workflow run must belong to the agent and have produced its result.
// A value cited from a CSV/TSV output with a row/column locator is compared
// with the file, and a mismatch is refused.
// The audit is computed from the stored entries on every read, so it always
// reflects the latest labels, closed issues and checklist answers.

const crypto = require('crypto');
const { READ_ROLES, MANAGE_ROLES, codedError } = require('../policy/agentCapabilities');
const { recordAutomationEvent } = require('../automation/automationAudit');
const {
  LEDGER_SCHEMA, normalizeLedgerEntry, auditLedger, renderAuditMarkdown, LedgerValidationError, checkCitedValue,
} = require('../../shared/analysisLedger.mjs');

const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_ENTRIES_PER_DELEGATION = 2000;
const ENTRY_KINDS = ['decision', 'annotation', 'finding', 'issue', 'check'];

function requireHuman(actor) {
  if (actor?.kind !== 'human') throw codedError('HUMAN_ACTOR_REQUIRED', 'This operation requires a signed-in person.', 403);
}

function sha(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function publicEntry(row) {
  return {
    id: row.id,
    ...row.entry_json,
    agent: { principalId: row.agent_principal_id, displayName: row.agent_display_name || null },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

const ENTRY_SELECT = `
  SELECT e.*, ap.display_name AS agent_display_name
    FROM agent_ledger_entries e
    JOIN agent_principals ap ON ap.id = e.agent_principal_id`;

function createAgentLedgerService({ db, withTransaction, sandboxes, admission }) {
  // Resolves every reference to a run the agent owns and records what was
  // cited (file checksum, script checksum), so the reviewer sees exactly the
  // bytes the agent read.
  async function verifyEvidence(actor, evidence) {
    const verified = [];
    for (const ref of evidence) {
      if (ref.sandboxRunId) {
        const run = sandboxes ? await sandboxes.getRunForAgent(actor, ref.sandboxRunId).catch(() => null) : null;
        if (!run) throw codedError('EVIDENCE_NOT_FOUND', `Sandbox run ${ref.sandboxRunId} not found.`, 404);
        if (run.state !== 'draft_ready') throw codedError('EVIDENCE_NOT_READY', `Sandbox run ${run.id} has no outputs (${run.state}).`, 409);
        const listed = (run.files || []).find((entry) => entry.name === ref.file);
        if (!listed) throw codedError('EVIDENCE_NOT_FOUND', `Run ${run.id} has no output named ${ref.file}.`, 404);
        const out = { ...ref, checksumSha256: listed.checksumSha256, scriptSha256: run.scriptSha256 };
        if (ref.value && /\.(csv|tsv)$/i.test(ref.file)) {
          const table = sandboxes.tableForLedger
            ? await sandboxes.tableForLedger(actor, run.id, ref.file).catch(() => null) : null;
          const check = table ? checkCitedValue(table.content.toString('utf8'), ref) : { status: 'unchecked' };
          if (check.status === 'mismatched') {
            const error = codedError('EVIDENCE_VALUE_MISMATCH',
              `${ref.file} at "${ref.locator}" does not hold ${ref.value}: ${check.reason}.`, 409);
            error.details = { file: ref.file, locator: ref.locator, value: ref.value, found: check.found ?? null };
            throw error;
          }
          out.valueCheck = check.status;
        }
        verified.push(out);
      } else if (ref.runId) {
        const run = admission ? await admission.getRunForAgent(actor, ref.runId).catch(() => null) : null;
        if (!run) throw codedError('EVIDENCE_NOT_FOUND', `Run ${ref.runId} not found.`, 404);
        if (run.state !== 'candidate_ready') throw codedError('EVIDENCE_NOT_READY', `Run ${run.id} has no result (${run.state}).`, 409);
        verified.push({ ...ref, releaseKey: run.release?.key || null });
      } else {
        throw codedError('EVIDENCE_RUN_REQUIRED', 'Each evidence entry names the sandboxRunId or runId whose output it cites.', 400);
      }
    }
    return verified;
  }

  async function entriesForAgent(runner, actor) {
    const { rows } = await runner.query(
      `${ENTRY_SELECT} WHERE e.project_id = $1 AND e.delegation_id = $2 ORDER BY e.created_at, e.id`,
      [actor.delegation.projectId, actor.delegation.id]);
    return rows.map(publicEntry);
  }

  async function recordForAgent(actor, body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw codedError('INVALID_INPUT', 'A JSON object is required.', 400);
    if (!REQUEST_ID.test(String(body.requestId))) {
      throw codedError('INVALID_REQUEST_ID', 'requestId must be 8-80 letters, digits, "-" or "_".', 400);
    }
    const { requestId, ...input } = body;
    return withTransaction(async (client) => {
      // Serializes this delegation's ledger so replay, the cap and refersTo
      // checks cannot race a concurrent write.
      await client.query('SELECT id FROM agent_delegations WHERE id = $1 FOR UPDATE', [actor.delegation.id]);
      const known = await entriesForAgent(client, actor);
      let entry;
      try {
        entry = normalizeLedgerEntry(input, { known: new Set(known.map((e) => e.id)) });
      } catch (error) {
        if (error instanceof LedgerValidationError) {
          const coded = codedError(error.code, error.message, 400);
          coded.details = { field: error.field };
          throw coded;
        }
        throw error;
      }
      const requestSha256 = sha(entry);
      const { rows: prior } = await client.query(
        `${ENTRY_SELECT} WHERE e.delegation_id = $1 AND e.request_id = $2`, [actor.delegation.id, requestId]);
      if (prior[0]) {
        if (prior[0].request_sha256 !== requestSha256) {
          throw codedError('IDEMPOTENCY_CONFLICT', 'This requestId was already used for a different ledger entry.', 409);
        }
        return { entry: publicEntry(prior[0]), replayed: true };
      }
      if (known.length >= MAX_ENTRIES_PER_DELEGATION) {
        throw codedError('QUOTA_EXCEEDED', `This delegation already wrote ${MAX_ENTRIES_PER_DELEGATION} ledger entries.`, 409);
      }
      entry.evidence = await verifyEvidence(actor, entry.evidence);
      const id = `led_${crypto.randomBytes(12).toString('hex')}`;
      await client.query(
        `INSERT INTO agent_ledger_entries (id, project_id, delegation_id, agent_principal_id, sponsor_user_id,
           request_id, request_sha256, entry_kind, analysis_tab, refers_to, entry_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, actor.delegation.projectId, actor.delegation.id, actor.principalId, actor.sponsorUserId,
          requestId, requestSha256, entry.kind, entry.tab, entry.refersTo || null, JSON.stringify(entry)]);
      await recordAutomationEvent(client, {
        projectId: actor.delegation.projectId, actor, action: `ledger.${entry.kind}-recorded`, decision: 'allowed',
        targetType: 'ledger_entry', targetId: id, requestId,
      });
      const { rows } = await client.query(`${ENTRY_SELECT} WHERE e.id = $1`, [id]);
      return { entry: publicEntry(rows[0]), replayed: false };
    });
  }

  function kindFilter(kind) {
    if (kind === undefined) return undefined;
    if (!ENTRY_KINDS.includes(kind)) throw codedError('INVALID_INPUT', `kind must be one of: ${ENTRY_KINDS.join(', ')}.`, 400);
    return kind;
  }

  async function readForAgent(actor, { kind } = {}) {
    const filter = kindFilter(kind);
    const entries = await entriesForAgent(db, actor);
    return { schema: LEDGER_SCHEMA, entries: filter ? entries.filter((e) => e.kind === filter) : entries };
  }

  // The agent's own audit, optionally checked against a report's text, so it
  // can close the gaps before asking for review.
  async function auditForAgent(actor, { reportText } = {}) {
    return auditLedger(await entriesForAgent(db, actor), { reportText });
  }

  // People: the sponsor sees their agents' ledgers; owners and admins see
  // every agent's in the project. One ledger per delegation.
  async function humanEntries(actor, projectId) {
    requireHuman(actor);
    const membership = await db.requireProjectRole(actor.userId, projectId, READ_ROLES);
    const all = MANAGE_ROLES.includes(membership.role);
    const { rows } = await db.query(
      `${ENTRY_SELECT} WHERE e.project_id = $1 AND ($2::boolean OR e.sponsor_user_id = $3)
        ORDER BY e.created_at, e.id LIMIT 20000`, [String(projectId), all, actor.userId]);
    return rows;
  }

  async function ledgersForHuman(actor, projectId) {
    const rows = await humanEntries(actor, projectId);
    const byDelegation = new Map();
    for (const row of rows) {
      if (!byDelegation.has(row.delegation_id)) {
        byDelegation.set(row.delegation_id, {
          delegationId: row.delegation_id,
          agent: { principalId: row.agent_principal_id, displayName: row.agent_display_name || null },
          entries: [],
        });
      }
      byDelegation.get(row.delegation_id).entries.push(publicEntry(row));
    }
    return {
      schema: `${LEDGER_SCHEMA}.project`,
      ledgers: [...byDelegation.values()].map((ledger) => ({ ...ledger, audit: auditLedger(ledger.entries) })),
    };
  }

  // The audit appended to a report's export: the ledger of the delegation
  // that wrote the report, cross-checked against the report's text.
  async function auditForReport(runner, { projectId, delegationId, reportText }) {
    const { rows } = await runner.query(
      `${ENTRY_SELECT} WHERE e.project_id = $1 AND e.delegation_id = $2 ORDER BY e.created_at, e.id`,
      [String(projectId), delegationId]);
    if (!rows.length) return null;
    const audit = auditLedger(rows.map(publicEntry), { reportText });
    return { audit, markdown: renderAuditMarkdown(audit) };
  }

  return { recordForAgent, readForAgent, auditForAgent, ledgersForHuman, auditForReport };
}

module.exports = { createAgentLedgerService, MAX_ENTRIES_PER_DELEGATION };
