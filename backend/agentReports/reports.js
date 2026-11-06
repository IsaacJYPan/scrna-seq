'use strict';

// Agent-drafted reports (docs/spec.md phase 5).
//
// An agent writes a report one section at a time. Each write stores a new
// immutable version of that section; figures point at output files of the
// agent's own sandbox runs. People review each section version (approve,
// request changes, or comment). The agent reads the reviews and revises.
// Only a person can finalize a report, and only when the latest version of
// every section is approved.

const crypto = require('crypto');
const { READ_ROLES, WRITE_ROLES, MANAGE_ROLES, codedError } = require('../policy/agentCapabilities');
const { recordAutomationEvent } = require('../automation/automationAudit');
const { fileKind } = require('../agentSandbox/bundleFiles');

const REPORT_ID = /^rep_[0-9a-f]{24}$/;
const SECTION_ID = /^sec_[0-9a-f]{24}$/;
const SANDBOX_RUN_ID = /^sbr_[0-9a-f]{24}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const SECTION_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SECTIONS = 100;
const MAX_FIGURES = 20;
const MAX_BODY_BYTES = 65536;
const MAX_REPORTS_PER_AGENT = 50;

function rejectUnknown(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw codedError('INVALID_INPUT', 'A JSON object is required.', 400);
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw codedError('UNKNOWN_FIELD', `Unknown field: ${key.slice(0, 64)}.`, 400);
  }
}

function text(value, field, max, { allowEmpty = false } = {}) {
  const result = typeof value === 'string' ? value.trim() : '';
  if ((!result && !allowEmpty) || result.length > max) throw codedError('INVALID_INPUT', `${field} must be 1-${max} characters.`, 400);
  return result;
}

function requireHuman(actor) {
  if (actor?.kind !== 'human') throw codedError('HUMAN_ACTOR_REQUIRED', 'This operation requires a signed-in person.', 403);
}

function sha(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function publicSection(row, reviews = []) {
  const mine = reviews.filter((review) => review.sectionId === row.id);
  const decisive = mine.filter((review) => review.decision !== 'comment');
  return {
    id: row.id,
    key: row.section_key,
    position: row.position,
    version: row.version,
    heading: row.heading,
    body: row.body_markdown,
    figures: row.figures_json,
    createdAt: row.created_at,
    status: decisive.length ? decisive[decisive.length - 1].decision : 'awaiting_review',
    reviews: mine,
  };
}

function publicReview(row) {
  return {
    id: row.id,
    sectionId: row.section_id,
    decision: row.decision,
    comment: row.comment,
    reviewer: { userId: Number(row.reviewer_user_id), displayName: row.reviewer_name || null },
    createdAt: row.created_at,
  };
}

function createReportService({ db, withTransaction, sandboxes }) {
  async function loadReport(runner, reportId) {
    const { rows } = await runner.query(
      `SELECT r.*, ap.display_name AS agent_display_name FROM agent_reports r
         JOIN agent_principals ap ON ap.id = r.agent_principal_id WHERE r.id = $1`, [reportId]);
    const report = rows[0];
    if (!report) return null;
    const { rows: sections } = await runner.query(
      'SELECT * FROM agent_report_sections WHERE report_id = $1 ORDER BY section_key, version', [reportId]);
    const { rows: reviews } = await runner.query(
      `SELECT rv.*, u.display_name AS reviewer_name FROM agent_report_reviews rv
         JOIN users u ON u.id = rv.reviewer_user_id WHERE rv.report_id = $1 ORDER BY rv.created_at, rv.id`, [reportId]);
    const reviewList = reviews.map(publicReview);
    const latest = new Map();
    const versions = new Map();
    for (const section of sections) {
      latest.set(section.section_key, section);
      versions.set(section.section_key, [...(versions.get(section.section_key) || []), section]);
    }
    const current = [...latest.values()].sort((a, b) => a.position - b.position || a.section_key.localeCompare(b.section_key));
    return {
      row: report,
      public: {
        id: report.id,
        projectId: report.project_id,
        title: report.title,
        status: report.status,
        agent: { principalId: report.agent_principal_id, displayName: report.agent_display_name },
        sponsorUserId: Number(report.sponsor_user_id),
        createdAt: report.created_at,
        finalizedAt: report.finalized_at,
        sections: current.map((section) => ({
          ...publicSection(section, reviewList),
          history: versions.get(section.section_key).slice(0, -1).map((older) => ({
            id: older.id, version: older.version, heading: older.heading, body: older.body_markdown,
            figures: older.figures_json, createdAt: older.created_at,
            reviews: reviewList.filter((review) => review.sectionId === older.id),
          })),
        })),
      },
    };
  }

  // ── Agent side ────────────────────────────────────────────────────────────
  async function agentReport(runner, actor, reportId) {
    if (!REPORT_ID.test(String(reportId))) throw codedError('NOT_FOUND', 'Report not found.', 404);
    const loaded = await loadReport(runner, reportId);
    if (!loaded || loaded.row.project_id !== actor.delegation.projectId || loaded.row.agent_principal_id !== actor.principalId) {
      throw codedError('NOT_FOUND', 'Report not found.', 404);
    }
    return loaded;
  }

  async function createForAgent(actor, body = {}) {
    rejectUnknown(body, ['requestId', 'title']);
    if (!REQUEST_ID.test(String(body.requestId))) throw codedError('INVALID_REQUEST_ID', 'requestId must be 8-80 letters, digits, "-" or "_".', 400);
    const title = text(body.title, 'title', 300);
    return withTransaction(async (client) => {
      const { rows: prior } = await client.query(
        'SELECT id, title FROM agent_reports WHERE delegation_id = $1 AND request_id = $2', [actor.delegation.id, body.requestId]);
      if (prior[0]) {
        if (prior[0].title !== title) throw codedError('IDEMPOTENCY_CONFLICT', 'This requestId was already used for a different report.', 409);
        return { report: (await loadReport(client, prior[0].id)).public, replayed: true };
      }
      const { rows: [count] } = await client.query(
        'SELECT COUNT(*)::int AS n FROM agent_reports WHERE agent_principal_id = $1 AND project_id = $2',
        [actor.principalId, actor.delegation.projectId]);
      if (count.n >= MAX_REPORTS_PER_AGENT) throw codedError('PROPOSAL_LIMIT', 'This agent has too many reports in this project.', 429);
      const id = `rep_${crypto.randomBytes(12).toString('hex')}`;
      await client.query(
        `INSERT INTO agent_reports (id, project_id, delegation_id, agent_principal_id, sponsor_user_id, request_id, title)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, actor.delegation.projectId, actor.delegation.id, actor.principalId, actor.sponsorUserId, body.requestId, title]);
      await recordAutomationEvent(client, {
        projectId: actor.delegation.projectId, actor, action: 'report.created', decision: 'allowed',
        targetType: 'report', targetId: id, requestId: body.requestId,
      });
      return { report: (await loadReport(client, id)).public, replayed: false };
    });
  }

  async function listForAgent(actor) {
    const { rows } = await db.query(
      `SELECT id FROM agent_reports WHERE project_id = $1 AND agent_principal_id = $2 ORDER BY created_at DESC LIMIT 100`,
      [actor.delegation.projectId, actor.principalId]);
    const reports = [];
    for (const row of rows) {
      const { public: report } = await loadReport(db, row.id);
      reports.push({
        id: report.id, title: report.title, status: report.status, createdAt: report.createdAt,
        sections: report.sections.map((s) => ({ key: s.key, version: s.version, heading: s.heading, status: s.status })),
      });
    }
    return reports;
  }

  async function getForAgent(actor, reportId) {
    return (await agentReport(db, actor, reportId)).public;
  }

  async function validateFigures(actor, figures) {
    if (figures === undefined) return [];
    if (!Array.isArray(figures) || figures.length > MAX_FIGURES) {
      throw codedError('INVALID_INPUT', `figures must be a list of at most ${MAX_FIGURES} entries.`, 400);
    }
    const result = [];
    for (const figure of figures) {
      rejectUnknown(figure, ['sandboxRunId', 'file', 'caption']);
      if (!SANDBOX_RUN_ID.test(String(figure.sandboxRunId))) throw codedError('INVALID_INPUT', 'Each figure needs a sandboxRunId.', 400);
      const file = text(figure.file, 'file', 160);
      const caption = text(figure.caption ?? '', 'caption', 2000, { allowEmpty: true });
      const kind = fileKind(file)?.kind;
      if (!['image', 'text'].includes(kind) && !/\.pdf$/i.test(file)) {
        throw codedError('INVALID_INPUT', 'Figures must be PNG, SVG, or PDF files, or CSV/TSV tables.', 400);
      }
      const run = await sandboxes.getRunForAgent(actor, figure.sandboxRunId).catch(() => null);
      if (!run) throw codedError('NOT_FOUND', `Sandbox run ${figure.sandboxRunId} not found.`, 404);
      if (run.state !== 'draft_ready') throw codedError('INVALID_INPUT', `Sandbox run ${run.id} has no outputs (${run.state}).`, 409);
      const listed = run.files.find((entry) => entry.name === file);
      if (!listed) throw codedError('NOT_FOUND', `Run ${run.id} has no output named ${file}.`, 404);
      result.push({ sandboxRunId: run.id, file, caption, checksumSha256: listed.checksumSha256, scriptSha256: run.scriptSha256 });
    }
    return result;
  }

  async function writeSectionForAgent(actor, reportId, body = {}) {
    rejectUnknown(body, ['requestId', 'key', 'heading', 'body', 'position', 'figures']);
    if (!REQUEST_ID.test(String(body.requestId))) throw codedError('INVALID_REQUEST_ID', 'requestId must be 8-80 letters, digits, "-" or "_".', 400);
    const key = String(body.key || '');
    if (!SECTION_KEY.test(key)) throw codedError('INVALID_INPUT', 'key must be 1-64 lowercase letters, digits, or "-", for example "methods".', 400);
    const heading = text(body.heading, 'heading', 300);
    const markdown = typeof body.body === 'string' ? body.body : '';
    if (Buffer.byteLength(markdown, 'utf8') > MAX_BODY_BYTES || markdown.includes('\0')) {
      throw codedError('INVALID_INPUT', `body must be at most ${MAX_BODY_BYTES} bytes of text.`, 400);
    }
    const position = body.position === undefined ? null : body.position;
    if (position !== null && (!Number.isSafeInteger(position) || position < 0 || position > 999)) {
      throw codedError('INVALID_INPUT', 'position must be an integer from 0 to 999.', 400);
    }
    const figures = await validateFigures(actor, body.figures);
    const requestSha256 = sha([reportId, key, heading, markdown, position, figures.map((f) => [f.sandboxRunId, f.file, f.caption])]);
    return withTransaction(async (client) => {
      const { rows: prior } = await client.query(
        'SELECT id, request_sha256 FROM agent_report_sections WHERE delegation_id = $1 AND request_id = $2',
        [actor.delegation.id, body.requestId]);
      if (prior[0]) {
        if (prior[0].request_sha256 !== requestSha256) throw codedError('IDEMPOTENCY_CONFLICT', 'This requestId was already used for a different section.', 409);
        const { public: report } = await agentReport(client, actor, reportId);
        const section = report.sections.find((s) => s.id === prior[0].id) || null;
        return { section, replayed: true };
      }
      await client.query('SELECT id FROM agent_reports WHERE id = $1 FOR UPDATE', [String(reportId)]);
      const { row } = await agentReport(client, actor, reportId);
      if (row.status !== 'draft') throw codedError('REPORT_FINALIZED', 'This report was finalized and cannot change.', 409);
      const { rows: existing } = await client.query(
        `SELECT section_key, MAX(version) AS version, MAX(position) AS position FROM agent_report_sections
          WHERE report_id = $1 GROUP BY section_key`, [row.id]);
      const same = existing.find((entry) => entry.section_key === key);
      if (!same && existing.length >= MAX_SECTIONS) throw codedError('PROPOSAL_LIMIT', `A report has at most ${MAX_SECTIONS} sections.`, 429);
      let finalPosition = position;
      if (finalPosition === null) {
        if (same) {
          const { rows: last } = await client.query(
            'SELECT position FROM agent_report_sections WHERE report_id = $1 AND section_key = $2 ORDER BY version DESC LIMIT 1',
            [row.id, key]);
          finalPosition = last[0].position;
        } else {
          finalPosition = Math.min(999, existing.reduce((max, entry) => Math.max(max, Number(entry.position) + 1), 0));
        }
      }
      const id = `sec_${crypto.randomBytes(12).toString('hex')}`;
      await client.query(
        `INSERT INTO agent_report_sections (id, report_id, project_id, section_key, position, version, heading, body_markdown,
           figures_json, delegation_id, agent_principal_id, request_id, request_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, row.id, row.project_id, key, finalPosition, (same ? Number(same.version) : 0) + 1, heading, markdown,
          JSON.stringify(figures), actor.delegation.id, actor.principalId, body.requestId, requestSha256]);
      await recordAutomationEvent(client, {
        projectId: row.project_id, actor, action: 'report.section-written', decision: 'allowed',
        targetType: 'report_section', targetId: id, requestId: body.requestId,
      });
      const { public: report } = await loadReport(client, row.id);
      return { section: report.sections.find((s) => s.id === id), replayed: false };
    });
  }

  // ── Human side ────────────────────────────────────────────────────────────
  // Reports cite the sponsor's private sandbox outputs, so the sponsor and the
  // project's owners and admins review them.
  async function humanReport(runner, actor, projectId, reportId, roles = READ_ROLES) {
    requireHuman(actor);
    const membership = await db.requireProjectRole(actor.userId, projectId, roles);
    if (!REPORT_ID.test(String(reportId))) throw codedError('NOT_FOUND', 'Report not found.', 404);
    const loaded = await loadReport(runner, reportId);
    if (!loaded || loaded.row.project_id !== String(projectId)
        || (Number(loaded.row.sponsor_user_id) !== Number(actor.userId) && !MANAGE_ROLES.includes(membership.role))) {
      throw codedError('NOT_FOUND', 'Report not found.', 404);
    }
    return loaded;
  }

  async function listForHuman(actor, projectId) {
    requireHuman(actor);
    const membership = await db.requireProjectRole(actor.userId, projectId, READ_ROLES);
    const { rows } = await db.query(
      `SELECT id FROM agent_reports WHERE project_id = $1 AND ($2::boolean OR sponsor_user_id = $3)
        ORDER BY created_at DESC LIMIT 200`, [String(projectId), MANAGE_ROLES.includes(membership.role), actor.userId]);
    const reports = [];
    for (const row of rows) {
      const { public: report } = await loadReport(db, row.id);
      reports.push({
        id: report.id, title: report.title, status: report.status, agent: report.agent, createdAt: report.createdAt,
        finalizedAt: report.finalizedAt, sectionCount: report.sections.length,
        approvedSections: report.sections.filter((s) => s.status === 'approved').length,
        awaitingReview: report.sections.filter((s) => s.status === 'awaiting_review').length,
      });
    }
    return { schema: 'traceomics.agent-reports.v1', reports };
  }

  async function getForHuman(actor, projectId, reportId) {
    return { schema: 'traceomics.agent-report.v1', report: (await humanReport(db, actor, projectId, reportId)).public };
  }

  async function reviewByHuman(actor, projectId, reportId, body = {}) {
    rejectUnknown(body, ['sectionId', 'decision', 'comment']);
    if (!SECTION_ID.test(String(body.sectionId))) throw codedError('INVALID_INPUT', 'sectionId is required.', 400);
    if (!['approved', 'changes_requested', 'comment'].includes(body.decision)) {
      throw codedError('INVALID_INPUT', 'decision must be approved, changes_requested, or comment.', 400);
    }
    const comment = text(body.comment ?? '', 'comment', 4000, { allowEmpty: true });
    if (body.decision !== 'approved' && !comment) throw codedError('INVALID_INPUT', 'Say what should change.', 400);
    return withTransaction(async (client) => {
      const { row } = await humanReport(client, actor, projectId, reportId, WRITE_ROLES);
      if (row.status !== 'draft') throw codedError('REPORT_FINALIZED', 'This report was finalized.', 409);
      const { rows } = await client.query('SELECT id FROM agent_report_sections WHERE id = $1 AND report_id = $2', [body.sectionId, row.id]);
      if (!rows[0]) throw codedError('NOT_FOUND', 'Section not found.', 404);
      const id = `rvw_${crypto.randomBytes(12).toString('hex')}`;
      await client.query(
        `INSERT INTO agent_report_reviews (id, report_id, section_id, project_id, reviewer_user_id, decision, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, row.id, body.sectionId, row.project_id, actor.userId, body.decision, comment]);
      await recordAutomationEvent(client, {
        projectId: row.project_id, actor, action: `report.review-${body.decision.replace('_', '-')}`, decision: 'allowed',
        targetType: 'report_section', targetId: body.sectionId,
      });
      return { schema: 'traceomics.agent-report.v1', report: (await loadReport(client, row.id)).public };
    });
  }

  async function finalizeByHuman(actor, projectId, reportId, body = {}) {
    rejectUnknown(body, []);
    return withTransaction(async (client) => {
      await client.query('SELECT id FROM agent_reports WHERE id = $1 FOR UPDATE', [String(reportId)]);
      const { row, public: report } = await humanReport(client, actor, projectId, reportId, WRITE_ROLES);
      if (row.status === 'finalized') return { schema: 'traceomics.agent-report.v1', report };
      const pending = report.sections.filter((section) => section.status !== 'approved');
      if (!report.sections.length || pending.length) {
        const error = codedError('REVIEW_INCOMPLETE', 'Approve the latest version of every section before finalizing.', 409);
        error.details = { sections: pending.map((section) => section.key) };
        throw error;
      }
      await client.query(
        "UPDATE agent_reports SET status = 'finalized', finalized_at = now(), finalized_by_user_id = $2 WHERE id = $1",
        [row.id, actor.userId]);
      await recordAutomationEvent(client, {
        projectId: row.project_id, actor, action: 'report.finalized', decision: 'allowed', targetType: 'report', targetId: row.id,
      });
      return { schema: 'traceomics.agent-report.v1', report: (await loadReport(client, row.id)).public };
    });
  }

  async function exportMarkdown(actor, projectId, reportId) {
    const { public: report } = await humanReport(db, actor, projectId, reportId);
    const lines = [`# ${report.title}`, ''];
    lines.push(report.status === 'finalized'
      ? `_Finalized ${new Date(report.finalizedAt).toISOString().slice(0, 10)}. Drafted by ${report.agent.displayName || 'an agent'}; every section approved by a reviewer._`
      : `_Draft. ${report.sections.filter((s) => s.status === 'approved').length} of ${report.sections.length} sections approved._`, '');
    const provenance = [];
    for (const section of report.sections) {
      lines.push(`## ${section.heading}`, '', section.body.trim(), '');
      section.figures.forEach((figure) => {
        const path = `figures/${figure.sandboxRunId}/${figure.file}`;
        lines.push(/\.(png|svg)$/i.test(figure.file) ? `![${figure.caption.replace(/[[\]]/g, '')}](${path})` : `[${figure.file}](${path})`);
        if (figure.caption) lines.push('', `*${figure.caption}*`);
        lines.push('');
        provenance.push(`- \`${path}\`: sandbox run ${figure.sandboxRunId}, script SHA-256 ${figure.scriptSha256}, file SHA-256 ${figure.checksumSha256}`);
      });
    }
    if (provenance.length) lines.push('## Figure provenance', '', ...provenance, '');
    const slug = report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';
    return { filename: `${slug}.md`, markdown: `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n` };
  }

  return {
    createForAgent, listForAgent, getForAgent, writeSectionForAgent,
    listForHuman, getForHuman, reviewByHuman, finalizeByHuman, exportMarkdown,
  };
}

module.exports = { createReportService };
