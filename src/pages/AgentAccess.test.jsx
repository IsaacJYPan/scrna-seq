import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentAccess from './AgentAccess';

const workspace = { projects: [{ id: 'proj_1', name: 'Atlas project', role: 'analyst' }], selectedProjectId: 'proj_1' };
const TOKEN = `tro_agent_${'B'.repeat(43)}`;

const catalog = [
  { name: 'metadata.read', availability: 'delegable', sponsorRoles: ['owner', 'admin', 'analyst', 'viewer'] },
  { name: 'proposal.create', availability: 'delegable', sponsorRoles: ['owner', 'admin', 'analyst'] },
  { name: 'workflow.executeApproved', availability: 'planned' },
  { name: 'workflow.approve', availability: 'human-only' },
];

const delegation = {
  id: 'dlg_1', status: 'active', projectId: 'proj_1',
  agent: { id: 'agt_1', displayName: 'QC helper', clientLabel: 'model-x', status: 'active' },
  sponsor: { userId: 7, displayName: 'Dana' },
  capabilities: ['metadata.read'], disclosureProfile: 'identifiers',
  policy: { maxOpenProposals: 10, maxRequestsPerMinute: 60 },
  expiresAt: '2030-01-01T00:00:00Z', revokedAt: null, revocationReason: null,
  credentials: [{ id: 'agcred_1', hint: 'tro_agent_abcdef…', status: 'active', expiresAt: '2030-01-01T00:00:00Z', lastUsedAt: null }],
};

const proposal = {
  id: 'prop_1', kind: 'code', title: 'Add QC metric', summary: 'Adds a metric', reviewState: 'open',
  agent: { principalId: 'agt_1', displayName: 'QC helper' }, bodySha256: 'f'.repeat(64), bodyBytes: 40,
  createdAt: '2026-11-01T00:00:00Z',
};

describe('AgentAccess', () => {
  beforeEach(() => {
    window.electronAPI = {
      listAgentDelegations: vi.fn(async () => ({ viewerRole: 'analyst', scope: 'mine', catalog, delegations: [delegation] })),
      listAgentProposals: vi.fn(async () => ({ proposals: [proposal] })),
      listAutomationAudit: vi.fn(async () => ({ events: [
        { id: 'aae_1', actor: { kind: 'agent', principalId: 'agt_1', displayName: 'QC helper' }, action: 'proposal.created', decision: 'allowed', createdAt: '2026-11-01T00:00:00Z' },
      ] })),
      createAgentDelegation: vi.fn(async () => ({
        delegation: { ...delegation, agent: { ...delegation.agent, displayName: 'New agent' } },
        credential: { id: 'agcred_2', token: TOKEN, expiresAt: '2030-01-01T00:00:00Z' },
      })),
      getAgentProposal: vi.fn(async () => ({ ...proposal, body: '<img src=x onerror=alert(1)>\n+ run me' })),
      reviewAgentProposal: vi.fn(async () => ({ ...proposal, reviewState: 'noted' })),
      revokeAgentDelegation: vi.fn(async () => ({ revoked: true })),
      revokeAllAgentDelegations: vi.fn(async () => ({ revoked: 1 })),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('shows the agent, its sponsor, and effective limits, and offers only delegable capabilities', async () => {
    render(<AgentAccess currentWs={workspace} userId={7} />);
    expect(await screen.findByText('QC helper', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText(/Sponsor: Dana \(you\)/)).toBeInTheDocument();
    expect(screen.getByText(/10 open proposals · 60 requests\/min · execution off/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Read project and dataset metadata/)).toBeEnabled();
    expect(screen.queryByText('workflow.executeApproved')).not.toBeInTheDocument();
    expect(screen.queryByText('workflow.approve')).not.toBeInTheDocument();
  });

  it('shows a new credential once and sends only the chosen delegation', async () => {
    render(<AgentAccess currentWs={workspace} userId={7} />);
    await screen.findByText('QC helper', { selector: 'p' });
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'New agent' } });
    fireEvent.click(screen.getByLabelText(/Submit code or method proposals/));
    fireEvent.click(screen.getByRole('button', { name: /create agent and credential/i }));
    expect(await screen.findByTestId('agent-token')).toHaveTextContent(TOKEN);
    expect(window.electronAPI.createAgentDelegation).toHaveBeenCalledWith('proj_1', {
      agentName: 'New agent', capabilities: ['metadata.read', 'proposal.create'], disclosureProfile: 'identifiers',
      lifetimeSeconds: 604800, limits: { maxOpenProposals: 10 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByTestId('agent-token')).not.toBeInTheDocument());
  });

  it('renders proposal content as inert text and records a non-approval review', async () => {
    const { container } = render(<AgentAccess currentWs={workspace} userId={7} />);
    fireEvent.click(await screen.findByRole('button', { name: /Add QC metric/ }));
    expect(await screen.findByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Note for later' }));
    await waitFor(() => expect(window.electronAPI.reviewAgentProposal).toHaveBeenCalledWith('proj_1', 'prop_1', 'noted', ''));
  });

  it('exposes the personal kill switch and hides the project-wide one from non-managers', async () => {
    render(<AgentAccess currentWs={workspace} userId={7} />);
    await screen.findByText('QC helper', { selector: 'p' });
    expect(screen.queryByRole('button', { name: /every agent in project/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /revoke all my agents/i }));
    await waitFor(() => expect(window.electronAPI.revokeAllAgentDelegations).toHaveBeenCalledWith('proj_1', 'mine'));
  });
});
