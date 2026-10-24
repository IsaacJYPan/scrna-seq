import React, { useEffect, useRef, useState } from 'react';
import Login from '../pages/Login';
import useSharedSnapshot from './useSharedSnapshot';

const SharedSnapshotLanding = React.lazy(() => import('./SharedSnapshotLanding'));

export function SharedSnapshotLoading() {
  return <main className="flex h-dvh items-center justify-center bg-background p-6 text-text"><p role="status">Opening shared snapshot…</p></main>;
}

export default function SharedSnapshotEntry({ target, onOpenWorkspace }) {
  const { state, refresh, onReadFailure, logout } = useSharedSnapshot(target);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') === 'dark' ? 'dark' : 'light');
  const [selection, setSelection] = useState(null);
  const selectionScope = state.user?.id ? JSON.stringify([target.serviceId, target.projectId, target.analysisId,
    target.publicationId, target.snapshotSha256, state.user.id]) : null;
  const liveSelectionScope = useRef(selectionScope);
  liveSelectionScope.current = state.status === 'ready' && state.record?.policy?.state !== 'withdrawn' ? selectionScope : null;
  useEffect(() => {
    if (['signed-out', 'denied', 'wrong-workspace'].includes(state.status) || state.record?.policy?.state === 'withdrawn') setSelection(null);
  }, [state.status, state.record?.policy?.state]);
  useEffect(() => {
    localStorage.setItem('theme', theme);
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    window.electronAPI?.setTheme?.(theme);
  }, [theme]);
  if (state.status === 'signed-out') return <Login onLogin={refresh} allowDemo={false} submitLabel="Open shared snapshot" pendingLabel="Opening shared snapshot…"
    notice={[state.notice, 'Sign in to the workspace that hosts this shared snapshot. Your exact link will be kept.'].filter(Boolean).join(' ')} theme={theme} setTheme={setTheme} />;
  return <React.Suspense fallback={<SharedSnapshotLoading />}><SharedSnapshotLanding state={state} onRefresh={refresh}
    onReadFailure={onReadFailure} onLogout={logout} onOpenWorkspace={onOpenWorkspace} theme={theme} setTheme={setTheme}
    initialFindingId={selectionScope && selection?.scope === selectionScope ? selection.viewId : null}
    onFindingSelection={viewId => {
      if (state.status === 'ready' && selectionScope && liveSelectionScope.current === selectionScope) setSelection({ scope: selectionScope, viewId });
    }} /></React.Suspense>;
}
