import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const db = require('./pgDatabase');
const accountAdmin = require('../scripts/account-admin');

const CONFIGURED = config.hasPostgresConnection();

function runAccountAdmin(args, password) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts', 'account-admin.js'), ...args], {
      cwd: process.cwd(),
      env: { ...process.env },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(password);
  });
}

beforeAll(async () => {
  if (CONFIGURED) await db.initSchema();
});

beforeEach(async () => {
  if (CONFIGURED) await db.resetSchemaForTests();
});

afterAll(async () => {
  if (CONFIGURED) await db.close();
});

describe('account-admin input boundary', () => {
  it('never accepts a password in command-line arguments', () => {
    expect(() => accountAdmin.parseArgs([
      'create', '--email', 'owner@example.com', '--display-name', 'Owner', '--password', 'secret'
    ])).toThrow(/invalid/i);
  });

  it('requires display name only for create', () => {
    expect(() => accountAdmin.validateIdentity({
      action: 'create', email: 'owner@example.com', displayName: '', passwordStdin: true,
    })).toThrow();
    expect(() => accountAdmin.validateIdentity({
      action: 'reset-password', email: 'owner@example.com', displayName: '', passwordStdin: true,
    })).not.toThrow();
  });
});

describe.skipIf(!CONFIGURED)('operator account lifecycle', () => {
  it('creates and rotates accounts through stdin with transactional audit events', async () => {
    const originalPassword = 'operator-input-password-1';
    const replacementPassword = 'operator-input-password-2';
    const created = await runAccountAdmin([
      'create', '--email', 'owner@example.com', '--display-name', 'Deployment Owner', '--password-stdin'
    ], originalPassword);
    expect(created.code, created.stderr).toBe(0);
    expect(`${created.stdout}${created.stderr}`).not.toContain(originalPassword);
    expect(created.stdout).toMatch(/action=create/);

    const owner = await db.verifyUser('owner@example.com', originalPassword);
    expect(owner.error).toBeUndefined();
    const initialVersion = BigInt(owner.sessionVersion);
    const initialAudit = await db.query(
      `SELECT event_type, target_email, metadata_json
         FROM operator_audit_events
        WHERE target_user_id = $1
        ORDER BY id`,
      [owner.id]
    );
    expect(initialAudit.rows).toEqual([expect.objectContaining({
      event_type: 'account.provisioned', target_email: 'owner@example.com',
    })]);
    expect(JSON.parse(initialAudit.rows[0].metadata_json)).toEqual({ source: 'operator_cli' });

    const reset = await runAccountAdmin([
      'reset-password', '--email', 'owner@example.com', '--password-stdin'
    ], replacementPassword);
    expect(reset.code, reset.stderr).toBe(0);
    expect(`${reset.stdout}${reset.stderr}`).not.toContain(replacementPassword);
    expect(reset.stdout).toMatch(/action=reset-password/);
    expect((await db.verifyUser('owner@example.com', originalPassword)).error).toMatch(/invalid/i);
    const rotated = await db.verifyUser('owner@example.com', replacementPassword);
    expect(rotated.error).toBeUndefined();
    expect(BigInt(rotated.sessionVersion)).toBe(initialVersion + 1n);

    const audit = await db.query(
      `SELECT event_type, metadata_json
         FROM operator_audit_events
        WHERE target_user_id = $1
        ORDER BY id`,
      [owner.id]
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      'account.provisioned', 'account.password_reset'
    ]);
    expect(JSON.parse(audit.rows[1].metadata_json)).toEqual({
      source: 'operator_cli', sessionsRevoked: true,
    });
  });

  it('recreates an empty audit table with its user foreign key on test reset', async () => {
    const rows = await db.query('SELECT COUNT(*)::int AS count FROM operator_audit_events');
    expect(rows.rows[0].count).toBe(0);
    const constraints = await db.query(
      `SELECT conname
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'operator_audit_events' AND c.contype = 'f'`
    );
    expect(constraints.rows.length).toBeGreaterThan(0);
  });

  it('audits offline platform-capability grants and revocations transactionally', async () => {
    const user = await db.provisionUserByOperator('developer@example.com', 'developer-password', 'Developer');
    const granted = await db.setPipelineRegistryPublisherByEmail(user.email, true);
    const revoked = await db.setPipelineRegistryPublisherByEmail(user.email, false);
    const expertGranted = await db.setExpertRExecutorByEmail(user.email, true);
    const expertRevoked = await db.setExpertRExecutorByEmail(user.email, false);
    expect(granted).toEqual(expect.objectContaining({
      canPublishPipelineManifests: true,
      auditEventId: expect.any(String),
    }));
    expect(revoked).toEqual(expect.objectContaining({
      canPublishPipelineManifests: false,
      auditEventId: expect.any(String),
    }));
    expect(expertGranted).toEqual(expect.objectContaining({
      canExecuteExpertR: true,
      auditEventId: expect.any(String),
    }));
    expect(expertRevoked).toEqual(expect.objectContaining({
      canExecuteExpertR: false,
      auditEventId: expect.any(String),
    }));
    const audit = await db.query(
      `SELECT event_type, metadata_json
         FROM operator_audit_events
        WHERE target_user_id = $1
        ORDER BY id`,
      [user.id]
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      'account.provisioned',
      'platform_capability_granted',
      'platform_capability_revoked',
      'platform_capability_granted',
      'platform_capability_revoked',
    ]);
    expect(JSON.parse(audit.rows[1].metadata_json)).toEqual({ capability: 'pipeline_registry.publish' });
    expect(JSON.parse(audit.rows[3].metadata_json)).toEqual({ capability: 'expert_r.execute' });
  });

  it('lets a provisioned owner create a project and add another provisioned account', async () => {
    const owner = await db.provisionUserByOperator('owner@example.com', 'owner-password', 'Owner');
    await db.provisionUserByOperator('analyst@example.com', 'analyst-password', 'Analyst');
    const organization = await db.createOrganizationForUser(owner.id, { name: 'Deployment Lab' });
    const project = await db.createProjectForUser(owner.id, {
      organizationId: organization.id,
      name: 'First Project',
    });
    const member = await db.addProjectMemberByEmail(
      project.id,
      'analyst@example.com',
      'analyst',
      { userId: owner.id }
    );
    expect(member).toEqual(expect.objectContaining({ email: 'analyst@example.com', role: 'analyst' }));
  });
});
