import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SharedSnapshotEntry from './SharedSnapshotEntry';
import useSharedSnapshot from './useSharedSnapshot';

vi.mock('./useSharedSnapshot', () => ({ default: vi.fn() }));
vi.mock('../pages/Login', () => ({ default: ({ onLogin, notice, allowDemo, submitLabel }) => <div>
  <p>{notice}</p><p>{String(allowDemo)}</p><button onClick={() => onLogin({ user: { id: 999 } })}>{submitLabel}</button>
</div> }));
vi.mock('./SharedSnapshotLanding', () => ({ default: ({ state, onRefresh, onLogout, onOpenWorkspace, theme, setTheme, initialFindingId, onFindingSelection }) => <main>
  <p>{state.status}</p><p>{theme}</p><button onClick={onRefresh}>Check current access</button><button onClick={onLogout}>Sign out</button>
  <button onClick={onOpenWorkspace}>Open workspace</button><button onClick={() => setTheme('dark')}>Dark appearance</button>
  <p aria-label="Selected finding">{initialFindingId || 'first'}</p><button onClick={() => onFindingSelection('selected-view')}>Select another finding</button>
</main> }));
const actions = { refresh: vi.fn(), logout: vi.fn(), onReadFailure: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); delete document.documentElement.dataset.theme; window.electronAPI = { setTheme: vi.fn() }; });
afterEach(cleanup);

it('keeps the exact target through sign-in and rechecks cookie authority rather than trusting the login payload', async () => {
  const target = { publicationId: 'exact' }; useSharedSnapshot.mockReturnValue({ ...actions, state: { status: 'signed-out' } });
  render(<SharedSnapshotEntry target={target} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open shared snapshot' }));
  expect(actions.refresh).toHaveBeenCalledTimes(1); expect(useSharedSnapshot).toHaveBeenCalledWith(target);
  expect(screen.getByText('false')).toBeInTheDocument(); expect(screen.getByText(/Your exact link will be kept/)).toBeInTheDocument();
});
it('delegates explicit workspace and sign-out actions while persisting only appearance', async () => {
  useSharedSnapshot.mockReturnValue({ ...actions, state: { status: 'ready' } }); const open = vi.fn();
  render(<SharedSnapshotEntry target={{ publicationId: 'exact' }} onOpenWorkspace={open} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Dark appearance' }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  expect(Object.keys(localStorage)).toEqual(['theme']); expect(localStorage.getItem('theme')).toBe('dark');
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); expect(actions.logout).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace' })); expect(open).toHaveBeenCalledTimes(1);
});

it('keeps only the selected finding identity through a same-account authority recheck and clears it on access loss', async () => {
  const target = { publicationId: 'exact' }, ready = { status: 'ready', user: { id: 17 } };
  useSharedSnapshot.mockReturnValue({ ...actions, state: ready }); const view = render(<SharedSnapshotEntry target={target} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Select another finding' }));
  expect(screen.getByLabelText('Selected finding')).toHaveTextContent('selected-view');
  useSharedSnapshot.mockReturnValue({ ...actions, state: { status: 'loading', user: null } }); view.rerender(<SharedSnapshotEntry target={target} />);
  expect(screen.getByLabelText('Selected finding')).toHaveTextContent('first');
  useSharedSnapshot.mockReturnValue({ ...actions, state: ready }); view.rerender(<SharedSnapshotEntry target={target} />);
  expect(screen.getByLabelText('Selected finding')).toHaveTextContent('selected-view');
  useSharedSnapshot.mockReturnValue({ ...actions, state: { ...ready, user: { id: 18 } } }); view.rerender(<SharedSnapshotEntry target={target} />);
  expect(screen.getByLabelText('Selected finding')).toHaveTextContent('first');
  useSharedSnapshot.mockReturnValue({ ...actions, state: { ...ready, status: 'denied' } }); view.rerender(<SharedSnapshotEntry target={target} />);
  useSharedSnapshot.mockReturnValue({ ...actions, state: ready }); view.rerender(<SharedSnapshotEntry target={target} />);
  expect(screen.getByLabelText('Selected finding')).toHaveTextContent('first'); expect(Object.keys(localStorage)).toEqual(['theme']);
});
