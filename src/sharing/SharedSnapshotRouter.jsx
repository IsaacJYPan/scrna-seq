import React, { useEffect, useMemo, useRef, useState } from 'react';
import DemoRouter from '../demo/DemoRouter';
import { parseSharedSnapshotHash, buildSharedSnapshotUrl } from './sharedSnapshotLink';
import { parsePublicExampleHash, buildPublicExampleUrl } from '../examples/publicExampleRoute';

const SharedSnapshotEntry = React.lazy(() => import('./SharedSnapshotEntry'));
const PublicSavedExample = React.lazy(() => import('../examples/PublicSavedExample'));
const parseRoute = hash => parseSharedSnapshotHash(hash) || parsePublicExampleHash(hash);

export default function SharedSnapshotRouter() {
  const [hash, setHash] = useState(() => window.location.hash);
  const route = useMemo(() => parseRoute(hash), [hash]);
  const [workspaceVisited, setWorkspaceVisited] = useState(() => !route);
  const normalHash = useRef(route ? '' : hash);
  let sharedUrl = null;
  if (route?.kind === 'snapshot') {
    try { sharedUrl = buildSharedSnapshotUrl(route.target, window.location.href); }
    catch { /* An unsupported address must never close an editing workspace. */ }
  }
  const example = route?.kind === 'public-example', invalidExample = route?.kind === 'invalid-example';
  const exampleUrl = example ? buildPublicExampleUrl(window.location.href) : null;
  useEffect(() => {
    const changed = () => {
      const next = window.location.hash;
      if (!parseRoute(next)) { normalHash.current = next; setWorkspaceVisited(true); }
      setHash(next);
    };
    window.addEventListener('hashchange', changed); window.addEventListener('popstate', changed);
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener('popstate', changed); };
  }, []);
  const openWorkspace = () => {
    window.history.replaceState(null, '', window.location.pathname + window.location.search + normalHash.current);
    setHash(normalHash.current); setWorkspaceVisited(true);
  };
  if (workspaceVisited) return <div className="flex h-dvh min-h-0 flex-col">
    {route && <aside aria-label={example || invalidExample ? 'Public example link' : 'Shared snapshot link'} className="shrink-0 border-b border-border bg-surface p-3 text-sm text-text">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
        <p>{example ? 'Inspect the public saved example alongside your current work.' : invalidExample ? 'This public example link could not be read. Your workspace is still open.'
          : route.kind === 'snapshot' ? 'Open this shared snapshot alongside your current work.' : 'This shared snapshot link could not be read. Your workspace is still open.'}</p>
        {sharedUrl && <a className="text-primary underline" href={sharedUrl}
          target="_blank" rel="noopener noreferrer" onClick={openWorkspace}>Open shared snapshot in new tab</a>}
        {route.kind === 'snapshot' && !sharedUrl && <p>Open the complete shared link from a supported HTTP or HTTPS app address.</p>}
        {exampleUrl && <a className="text-primary underline" href={exampleUrl} target="_blank" rel="noopener noreferrer" onClick={openWorkspace}>Open public example in new tab</a>}
        <button type="button" className="text-primary underline" onClick={openWorkspace}>Dismiss</button>
      </div>
    </aside>}
    <div className="min-h-0 flex-1 [&>*]:h-full"><DemoRouter /></div>
  </div>;
  if (example) return <React.Suspense fallback={<main className="bg-background p-6 text-text"><p role="status">Opening public saved example…</p></main>}>
    <PublicSavedExample onOpenWorkspace={openWorkspace} />
  </React.Suspense>;
  if (route?.kind === 'snapshot') return <React.Suspense fallback={<main className="bg-background p-6 text-text"><p role="status">Opening shared snapshot…</p></main>}>
    <SharedSnapshotEntry key={hash} target={route.target} onOpenWorkspace={openWorkspace} />
  </React.Suspense>;
  return <main className="flex h-dvh items-center justify-center bg-background p-6 text-text"><section className="max-w-lg space-y-4">
    <h1 className="text-xl font-semibold">{invalidExample ? 'This public example link could not be read' : 'This shared snapshot link could not be read'}</h1>
    <p className="text-sm text-textMuted">{invalidExample ? 'Use the supported public saved-example link from sign-in. No private analysis or demo session has been opened.'
      : 'Use the complete link copied from a published snapshot. No analysis has been selected or started.'}</p>
    <button type="button" className="btn btn-secondary" onClick={openWorkspace}>Open workspace</button>
  </section></main>;
}
