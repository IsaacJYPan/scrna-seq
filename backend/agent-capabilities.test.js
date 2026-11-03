import { describe, it, expect } from 'vitest';

const caps = require('./policy/agentCapabilities');
const { authorizeAgentOperation } = require('./actors/delegations');
const { readAgentCredential, generateAgentToken } = require('./actors/agentCredentials');
const { agentActorContext } = require('./actors/actorContext');

function actor({ capabilities = ['metadata.read', 'proposal.create'], sponsorRole = 'analyst' } = {}) {
  return agentActorContext({
    agentPrincipalId: 'agt_x', agentDisplayName: 'x', sponsorUserId: 1, sponsorRole,
    delegationId: 'dlg_x', delegationVersion: 1, projectId: 'proj_a', capabilities,
    disclosureProfile: 'identifiers', policy: caps.normalizePolicy({}), delegationExpiresAt: null,
    credentialId: 'agcred_x', credentialExpiresAt: null,
  });
}

describe('agent capability policy', () => {
  it('never lets a delegation exceed the sponsor role or include non-delegable capabilities', () => {
    const roles = ['owner', 'admin', 'analyst', 'viewer'];
    const names = Object.keys(caps.CAPABILITIES);
    for (const role of roles) {
      for (const name of names) {
        let granted = null;
        try { granted = caps.normalizeCapabilities([name], role); } catch { granted = null; }
        if (granted) {
          expect(caps.isDelegable(name)).toBe(true);
          expect(caps.sponsorRolesFor(name)).toContain(role);
        }
      }
    }
  });

  it('denies unknown facts and narrows when the sponsor role narrows', () => {
    expect(authorizeAgentOperation(actor(), 'metadata.read', 'proj_a')).toBeNull();
    expect(authorizeAgentOperation(actor(), 'metadata.read', 'proj_b')).toBe('SCOPE_DENIED');
    expect(authorizeAgentOperation(actor(), 'results.read', 'proj_a')).toBe('SCOPE_DENIED');
    expect(authorizeAgentOperation(actor({ sponsorRole: 'viewer' }), 'proposal.create', 'proj_a')).toBe('SCOPE_DENIED');
    expect(authorizeAgentOperation(actor({ sponsorRole: null }), 'metadata.read', 'proj_a')).toBe('SCOPE_DENIED');
    expect(authorizeAgentOperation(actor({ capabilities: ['workflow.approve'] }), 'workflow.approve', 'proj_a')).toBe('SCOPE_DENIED');
    expect(authorizeAgentOperation({ kind: 'human', userId: 1 }, 'metadata.read', 'proj_a')).toBe('AGENT_CREDENTIAL_REQUIRED');
  });

  it('freezes the actor context so services cannot widen it', () => {
    const a = actor();
    expect(() => { 'use strict'; a.delegation.capabilities.push('workflow.approve'); }).toThrow();
    expect(() => { 'use strict'; a.kind = 'human'; }).toThrow();
  });

  it('fixes execution switches off and rejects unknown limits', () => {
    const policy = caps.normalizePolicy({ maxOpenProposals: 3 });
    expect(policy).toMatchObject({ maxOpenProposals: 3, allowArbitraryCode: false, allowCandidateCodeExecution: false });
    expect(() => caps.normalizePolicy({ allowGpu: true })).toThrow(/cannot be changed/);
    expect(() => caps.normalizePolicy({ maxReservedCpus: 8 })).toThrow(/Unknown/);
    expect(() => caps.normalizePolicy({ maxOpenProposals: 1.5 })).toThrow(/integer/);
  });

  it('recognizes agent-shaped credentials, including malformed ones', () => {
    const { token } = generateAgentToken();
    expect(readAgentCredential({ headers: { authorization: `Bearer ${token}` } })).toEqual({ present: true, token });
    expect(readAgentCredential({ headers: { authorization: 'Bearer tro_agent_bad' } })).toEqual({ present: true, token: null });
    expect(readAgentCredential({ headers: { authorization: `Basic ${token}` } })).toEqual({ present: true, token: null });
    expect(readAgentCredential({ headers: { authorization: 'Bearer some-session-token' } }).present).toBe(false);
    expect(readAgentCredential({ headers: {} }).present).toBe(false);
  });
});
