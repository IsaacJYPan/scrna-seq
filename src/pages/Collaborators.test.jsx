import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Collaborators from './Collaborators';

const ownerWorkspace = {
  projects: [{ id: 'proj_1', name: 'Atlas project', role: 'owner' }],
  selectedProjectId: 'proj_1',
};

const members = [
  { userId: 1, email: 'owner@example.org', displayName: 'Owner', role: 'owner' },
  { userId: 2, email: 'analyst@example.org', displayName: 'Analyst', role: 'analyst' },
];

describe('Collaborators', () => {
  beforeEach(() => {
    window.electronAPI = {
      listProjectMembers: vi.fn(async () => members),
      addProjectMember: vi.fn(async () => ({ userId: 3, email: 'new@example.org', role: 'viewer' })),
      updateProjectMemberRole: vi.fn(async () => ({ userId: 2, role: 'admin' })),
      removeProjectMember: vi.fn(async () => ({ success: true })),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('loads members and wires add, role-change, and confirmed removal to the project APIs', async () => {
    render(<Collaborators currentWs={ownerWorkspace} userId={1} refreshProjects={vi.fn()} />);

    expect(await screen.findByText('analyst@example.org')).toBeInTheDocument();
    expect(window.electronAPI.listProjectMembers).toHaveBeenCalledWith('proj_1');

    fireEvent.change(screen.getByLabelText('Account email'), { target: { value: 'new@example.org' } });
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));
    await waitFor(() => {
      expect(window.electronAPI.addProjectMember).toHaveBeenCalledWith('proj_1', 'new@example.org', 'viewer');
      expect(screen.getByLabelText('Account email')).toHaveValue('');
      expect(window.electronAPI.listProjectMembers.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    fireEvent.change(screen.getByLabelText('Role for analyst@example.org'), { target: { value: 'admin' } });
    await waitFor(() => {
      expect(window.electronAPI.updateProjectMemberRole).toHaveBeenCalledWith('proj_1', 2, 'admin');
      expect(screen.getByRole('button', { name: 'Remove analyst@example.org' })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove analyst@example.org' }));
    fireEvent.click(screen.getByRole('button', { name: /confirm remove/i }));
    await waitFor(() => {
      expect(window.electronAPI.removeProjectMember).toHaveBeenCalledWith('proj_1', 2);
    });
  });

  it('renders analysts and viewers as read-only member lists', async () => {
    const viewerWorkspace = {
      ...ownerWorkspace,
      projects: [{ ...ownerWorkspace.projects[0], role: 'viewer' }],
    };
    render(<Collaborators currentWs={viewerWorkspace} userId={4} />);

    expect(await screen.findByText('analyst@example.org')).toBeInTheDocument();
    expect(screen.queryByText('Add existing user')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Role for analyst@example.org')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove analyst@example.org' })).toBeDisabled();
  });

  it('shows backend permission conflicts and refreshes authoritative member state', async () => {
    window.electronAPI.updateProjectMemberRole.mockRejectedValueOnce(new Error('Cannot demote the last owner of the project.'));
    const refreshProjects = vi.fn(async () => {});
    render(<Collaborators currentWs={ownerWorkspace} userId={1} refreshProjects={refreshProjects} />);

    await screen.findByText('owner@example.org');
    fireEvent.change(screen.getByLabelText('Role for owner@example.org'), { target: { value: 'admin' } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/last owner/i);
    expect(window.electronAPI.listProjectMembers.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(refreshProjects).toHaveBeenCalled();
  });

  it('reconciles an externally demoted current user from the authoritative member list', async () => {
    window.electronAPI.listProjectMembers.mockResolvedValueOnce([
      { ...members[0], role: 'viewer' },
      members[1],
    ]);
    const refreshProjects = vi.fn(async () => {});

    render(<Collaborators currentWs={ownerWorkspace} userId={1} refreshProjects={refreshProjects} />);

    expect(await screen.findByText(/Your role: viewer/i)).toBeInTheDocument();
    expect(screen.queryByText('Add existing user')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Role for analyst@example.org')).toBeDisabled();
    expect(refreshProjects).toHaveBeenCalled();
  });

  it('never renders or mutates delayed member rows under a different project', async () => {
    let resolveA;
    let resolveB;
    const projectA = new Promise(resolve => { resolveA = resolve; });
    const projectB = new Promise(resolve => { resolveB = resolve; });
    window.electronAPI.listProjectMembers.mockImplementation(projectId => (
      projectId === 'proj_a' ? projectA : projectB
    ));
    const workspaceA = {
      projects: [{ id: 'proj_a', name: 'Project A', role: 'owner' }],
      selectedProjectId: 'proj_a',
    };
    const workspaceB = {
      projects: [{ id: 'proj_b', name: 'Project B', role: 'owner' }],
      selectedProjectId: 'proj_b',
    };
    const { rerender } = render(<Collaborators currentWs={workspaceA} userId={2} />);
    await waitFor(() => expect(window.electronAPI.listProjectMembers).toHaveBeenCalledWith('proj_a'));

    rerender(<Collaborators currentWs={workspaceB} userId={2} />);
    expect(screen.queryByText('a-target@example.org')).not.toBeInTheDocument();
    await act(async () => {
      resolveB([
        { userId: 2, email: 'b-owner@example.org', displayName: 'B Owner', role: 'owner' },
        { userId: 3, email: 'b-target@example.org', displayName: 'B Target', role: 'viewer' },
      ]);
      await projectB;
    });
    expect(await screen.findByText('b-target@example.org')).toBeInTheDocument();

    await act(async () => {
      resolveA([
        { userId: 2, email: 'a-owner@example.org', displayName: 'A Owner', role: 'owner' },
        { userId: 7, email: 'a-target@example.org', displayName: 'A Target', role: 'viewer' },
      ]);
      await projectA;
    });
    expect(screen.queryByText('a-target@example.org')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove b-target@example.org' }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm remove b-target@example.org from Project B/i }));
    await waitFor(() => {
      expect(window.electronAPI.removeProjectMember).toHaveBeenCalledWith('proj_b', 3);
    });
  });

  it('remounts project-specific form state before a project-switch paint', async () => {
    const workspaceA = {
      projects: [{ id: 'proj_a', name: 'Project A', role: 'owner' }],
      selectedProjectId: 'proj_a',
    };
    const workspaceB = {
      projects: [{ id: 'proj_b', name: 'Project B', role: 'owner' }],
      selectedProjectId: 'proj_b',
    };
    const { rerender } = render(<Collaborators currentWs={workspaceA} userId={1} />);
    await screen.findByText('analyst@example.org');
    const projectAEmail = screen.getByLabelText('Account email');
    fireEvent.change(projectAEmail, { target: { value: 'only-for-a@example.org' } });

    rerender(<Collaborators currentWs={workspaceB} userId={1} />);

    const projectBEmail = screen.getByLabelText('Account email');
    expect(projectBEmail).not.toBe(projectAEmail);
    expect(projectBEmail).toHaveValue('');
    expect(screen.getByText('Project B')).toBeInTheDocument();
    await screen.findByText('analyst@example.org');
  });

  it('does not render a delayed rejected mutation error under a new project', async () => {
    let rejectRoleChange;
    window.electronAPI.updateProjectMemberRole.mockImplementationOnce(() => (
      new Promise((resolve, reject) => { rejectRoleChange = reject; })
    ));
    const workspaceA = {
      projects: [{ id: 'proj_a', name: 'Project A', role: 'owner' }],
      selectedProjectId: 'proj_a',
    };
    const workspaceB = {
      projects: [{ id: 'proj_b', name: 'Project B', role: 'owner' }],
      selectedProjectId: 'proj_b',
    };
    const { rerender } = render(<Collaborators currentWs={workspaceA} userId={1} refreshProjects={vi.fn()} />);
    await screen.findByText('analyst@example.org');

    fireEvent.change(screen.getByLabelText('Role for analyst@example.org'), { target: { value: 'admin' } });
    await waitFor(() => expect(window.electronAPI.updateProjectMemberRole).toHaveBeenCalledWith('proj_a', 2, 'admin'));
    rerender(<Collaborators currentWs={workspaceB} userId={1} refreshProjects={vi.fn()} />);

    await act(async () => {
      rejectRoleChange(new Error('Project A role update rejected.'));
      await Promise.resolve();
    });

    expect(screen.queryByText(/Project A role update rejected/i)).not.toBeInTheDocument();
    expect(screen.getByText('Project B')).toBeInTheDocument();
    await screen.findByText('analyst@example.org');
  });
});
