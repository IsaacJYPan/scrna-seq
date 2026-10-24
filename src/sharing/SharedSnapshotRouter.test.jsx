import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SharedSnapshotRouter from './SharedSnapshotRouter';
import { buildSharedSnapshotHash } from './sharedSnapshotLink';

const mounted = vi.hoisted(() => ({ workspace: vi.fn(), reader: vi.fn(), teardown: vi.fn() }));
vi.mock('../demo/DemoRouter', () => ({ default: function Workspace() {
  React.useEffect(() => { mounted.workspace(); return mounted.teardown; }, []);
  return <main><label>Existing analysis draft<input defaultValue="Unsubmitted scientific work" /></label></main>;
} }));
vi.mock('./SharedSnapshotEntry', () => ({ default: function Reader({ target, onOpenWorkspace }) {
  mounted.reader(target); return <main><h1>Exact shared reader</h1><p>{target.publicationId}</p><button onClick={onOpenWorkspace}>Open workspace</button></main>;
} }));
const target = { serviceId: 'svc_' + 'a'.repeat(32), projectId: 'proj_' + 'b'.repeat(16), analysisId: 'ra_' + 'c'.repeat(24),
  publicationId: 'aspub_' + 'd'.repeat(24), snapshotSha256: 'e'.repeat(64) };
function navigate(hash) { window.history.replaceState(null, '', '/' + hash); fireEvent(window, new HashChangeEvent('hashchange')); }
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/'); });
afterEach(cleanup);

describe('shared snapshot route isolation and workspace continuity', () => {
  it('mounts only the exact reader on a fresh shared URL', async () => {
    navigate(buildSharedSnapshotHash(target)); render(<SharedSnapshotRouter />);
    expect(await screen.findByRole('heading', { name: 'Exact shared reader' })).toBeInTheDocument();
    expect(mounted.workspace).not.toHaveBeenCalled(); expect(mounted.reader).toHaveBeenLastCalledWith(target);
  });
  it('keeps malformed and unsupported shared routes outside the live app', () => {
    navigate('#/shared-snapshots/v99/unknown'); render(<SharedSnapshotRouter />);
    expect(screen.getByRole('heading', { name: 'This shared snapshot link could not be read' })).toBeInTheDocument();
    expect(mounted.workspace).not.toHaveBeenCalled(); expect(mounted.reader).not.toHaveBeenCalled();
  });
  it('requires an explicit action to leave the direct reader for the workspace', async () => {
    navigate(buildSharedSnapshotHash(target)); render(<SharedSnapshotRouter />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open workspace' }));
    expect(await screen.findByLabelText('Existing analysis draft')).toHaveValue('Unsubmitted scientific work');
    expect(window.location.hash).toBe(''); expect(mounted.workspace).toHaveBeenCalledTimes(1);
  });
  it('preserves an existing editing workspace while offering a separate reader tab', async () => {
    navigate('#analysis'); render(<SharedSnapshotRouter />);
    const draft = await screen.findByLabelText('Existing analysis draft'); fireEvent.change(draft, { target: { value: 'Keep my exact pending changes' } });
    navigate(buildSharedSnapshotHash(target));
    const link = screen.getByRole('link', { name: 'Open shared snapshot in new tab' });
    expect(link).toHaveAttribute('target', '_blank'); expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.href).toBe(window.location.origin + '/' + buildSharedSnapshotHash(target));
    expect(draft).toHaveValue('Keep my exact pending changes'); expect(mounted.workspace).toHaveBeenCalledTimes(1);
    expect(mounted.reader).not.toHaveBeenCalled(); expect(mounted.teardown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(window.location.hash).toBe('#analysis'); expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(draft).toHaveValue('Keep my exact pending changes'); expect(mounted.workspace).toHaveBeenCalledTimes(1);
  });
  it('keeps invalid later shared navigation from remounting or erasing the workspace', async () => {
    render(<SharedSnapshotRouter />); const draft = await screen.findByLabelText('Existing analysis draft');
    navigate('#/shared-snapshots/v1/not-an-exact-target');
    expect(screen.queryByRole('link')).not.toBeInTheDocument(); expect(draft).toBeInTheDocument();
    expect(mounted.workspace).toHaveBeenCalledTimes(1); expect(mounted.reader).not.toHaveBeenCalled();
  });
  it('preserves dirty work if the served app address cannot safely form a new-tab link', async () => {
    window.history.replaceState(null, '', '/lab%20folder/#analysis'); render(<SharedSnapshotRouter />);
    const draft = await screen.findByLabelText('Existing analysis draft'); fireEvent.change(draft, { target: { value: 'Keep this dirty work' } });
    window.history.replaceState(null, '', '/lab%20folder/' + buildSharedSnapshotHash(target)); fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.queryByRole('link')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(draft).toHaveValue('Keep this dirty work'); expect(mounted.teardown).not.toHaveBeenCalled(); expect(mounted.reader).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); expect(window.location.pathname).toBe('/lab%20folder/');
    expect(window.location.hash).toBe('#analysis'); expect(draft).toHaveValue('Keep this dirty work');
  });
  it('handles exact shared-to-shared and back navigation without consulting the workspace', async () => {
    navigate(buildSharedSnapshotHash(target)); render(<SharedSnapshotRouter />); await screen.findByRole('heading');
    const next = { ...target, publicationId: 'aspub_' + 'f'.repeat(24) }; navigate(buildSharedSnapshotHash(next));
    await waitFor(() => expect(mounted.reader).toHaveBeenLastCalledWith(next));
    navigate(buildSharedSnapshotHash(target)); await waitFor(() => expect(mounted.reader).toHaveBeenLastCalledWith(target));
    expect(mounted.workspace).not.toHaveBeenCalled();
  });
});
