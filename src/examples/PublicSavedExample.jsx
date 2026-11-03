import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Microscope, Moon, Sun } from 'lucide-react';
import { RetainedResultContent } from '../components/RetainedArtifactView';
import { loadPublicExampleManifest, readPublicExampleFinding, readPublicExampleSource } from './publicSavedExampleApi';

const invalid = error => error?.code === 'INVALID_PUBLIC_SAVED_EXAMPLE';
const findingProblem = kind => kind === 'invalid' ? 'This saved finding could not be verified. No preview is shown.'
  : kind === 'display' ? 'The figure bytes were verified, but the image could not be displayed.'
    : 'This saved finding is unavailable. Choose another finding or retry this one.';

function FindingPreview({ manifest, finding, cached, onRecord }) {
  const initial = useRef(cached), liveRecord = useRef(onRecord), image = useRef(null), generation = useRef(0);
  const [attempt, setAttempt] = useState(0), [state, setState] = useState({ status: 'loading' });
  liveRecord.current = onRecord;
  useEffect(() => {
    const id = ++generation.current, controller = new AbortController();
    const current = () => id === generation.current && !controller.signal.aborted;
    const clearImage = () => { if (image.current) { URL.revokeObjectURL(image.current); image.current = null; } };
    const accept = value => {
      if (!current()) return;
      let imageUrl = null;
      if (value.preview.family === 'image') {
        try { imageUrl = URL.createObjectURL(new Blob([value.imageBytes], { type: value.type })); }
        catch {
          const record = { status: 'error', kind: 'display', verified: true };
          liveRecord.current(finding.id, record); setState(record); return;
        }
        if (!current()) { URL.revokeObjectURL(imageUrl); return; }
        image.current = imageUrl;
      }
      const record = { status: 'ready', value }; liveRecord.current(finding.id, record);
      setState({ ...record, imageUrl });
    };
    clearImage(); setState({ status: 'loading' });
    const saved = attempt === 0 ? initial.current : null;
    if (saved?.status === 'error') setState(saved);
    else if (saved?.status === 'ready') accept(saved.value);
    else void (async () => {
      try { accept(await readPublicExampleFinding(manifest, finding.id, { signal: controller.signal })); }
      catch (error) {
        if (!current()) return;
        clearImage(); const record = { status: 'error', kind: invalid(error) ? 'invalid' : 'unavailable' };
        liveRecord.current(finding.id, record); setState(record);
      }
    })();
    return () => { controller.abort(); clearImage(); };
  }, [manifest, finding, attempt]);
  const failImage = imageUrl => {
    if (!imageUrl || image.current !== imageUrl) return;
    URL.revokeObjectURL(imageUrl); image.current = null;
    const record = { status: 'error', kind: 'display', verified: true };
    liveRecord.current(finding.id, record); setState(record);
  };
  const checked = state.status === 'ready' || state.verified === true;
  return <section aria-label="Selected public finding" className="min-w-0 space-y-3 rounded border border-border bg-surface p-4 sm:p-5">
    <h3 className="whitespace-pre-wrap break-words text-base font-semibold">{finding.caption}</h3>
    {state.status === 'loading' && <p role="status" className="text-sm text-textMuted">Opening this saved finding…</p>}
    {state.status === 'error' && <><p role="alert" className="text-sm text-textMuted">{findingProblem(state.kind)}</p>
      <button type="button" className="btn btn-secondary text-sm" onClick={() => setAttempt(value => value + 1)}>Retry finding</button></>}
    {checked && <p className="text-xs text-success">Selected payload and view descriptor checksums verified.</p>}
    {state.status === 'ready' && <RetainedResultContent preview={state.value.preview} imageUrl={state.imageUrl}
      name={finding.caption} integrityVerified fixedView onImageError={() => failImage(state.imageUrl)} />}
    <details className="text-xs text-textMuted"><summary className="cursor-pointer">Exact source and saved view</summary>
      <dl className="mt-3 space-y-3">
        <div><dt>Recorded CSV source SHA-256</dt><dd className="mt-1 break-all">{finding.sourceSha256}</dd></div>
        <div><dt>{checked ? 'Verified payload SHA-256' : 'Recorded payload SHA-256'}</dt><dd className="mt-1 break-all">{finding.asset.sha256}</dd></div>
        <div><dt>{checked ? 'Verified view descriptor SHA-256' : 'Recorded view descriptor SHA-256'}</dt><dd className="mt-1 break-all">{finding.viewSha256}</dd></div>
        <div><dt>Saved payload</dt><dd>{finding.asset.bytes.toLocaleString()} bytes · {finding.asset.mediaType}</dd></div>
      </dl>
      <p className="mt-3">The CSV identity is recorded here. Its bytes are checked separately when you open the source below.</p>
    </details>
  </section>;
}

function ExampleSource({ manifest }) {
  const [opened, setOpened] = useState(false), [attempt, setAttempt] = useState(0), [state, setState] = useState(null);
  const generation = useRef(0);
  useEffect(() => {
    const id = ++generation.current, controller = new AbortController();
    const current = () => id === generation.current && !controller.signal.aborted;
    setState(null);
    if (opened) void (async () => {
      try {
        const value = await readPublicExampleSource(manifest, { signal: controller.signal });
        if (current()) setState({ status: 'ready', value });
      } catch (error) { if (current()) setState({ status: 'error', kind: invalid(error) ? 'invalid' : 'unavailable' }); }
    })();
    return () => controller.abort();
  }, [manifest, opened, attempt]);
  return <section aria-label="Public example CSV source" className="space-y-3 rounded border border-border bg-surface p-4 sm:p-5">
    <h2 className="text-sm font-semibold">Optional CSV source</h2>
    <p className="text-xs text-textMuted">The authored source is {manifest.source.bytes} bytes. It is fetched only when you choose to inspect it.</p>
    <button type="button" className="btn btn-secondary text-sm" onClick={() => setOpened(value => !value)}>{opened ? 'Hide CSV source' : 'View CSV source'}</button>
    {opened && !state && <p role="status" className="text-sm text-textMuted">Checking the CSV source bytes…</p>}
    {opened && state?.status === 'error' && <><p role="alert" className="text-sm text-textMuted">{state.kind === 'invalid'
      ? 'The CSV source could not be verified. No source text is shown.' : 'The CSV source is unavailable. You can still inspect the saved findings.'}</p>
      <button type="button" className="text-sm text-primary underline" onClick={() => setAttempt(value => value + 1)}>Retry CSV source</button></>}
    {opened && state?.status === 'ready' && <>
      <p className="text-xs text-success">CSV source checksum verified · {state.value.bytes} bytes fetched.</p>
      <pre tabIndex={0} aria-label="Verified public CSV source" className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-3 text-xs">{state.value.text}</pre>
      <dl className="text-xs text-textMuted"><dt>Verified CSV source SHA-256</dt><dd className="mt-1 break-all">{state.value.sha256}</dd></dl>
    </>}
  </section>;
}

function ExampleContent({ manifest }) {
  const [selected, setSelected] = useState(manifest.findings[0].id), records = useRef(new Map()), heading = useRef(null);
  const finding = manifest.findings.find(value => value.id === selected) || manifest.findings[0];
  const record = useCallback((id, value) => { records.current.set(id, value); }, []);
  const select = id => { setSelected(id); requestAnimationFrame(() => heading.current?.focus({ preventScroll: true })); };
  return <>
    <section className="space-y-3"><p className="text-xs font-medium uppercase tracking-wide text-textMuted">Synthetic illustration · Version {manifest.version} · {manifest.provenance.license}</p>
      <h1 className="break-words text-2xl font-semibold">{manifest.title}</h1>
      <h2 className="text-sm font-semibold">Research question</h2><p className="whitespace-pre-wrap break-words text-sm">{manifest.question}</p>
      <p className="text-sm text-textMuted">{manifest.provenance.notice}</p>
      <p className="text-xs text-success">Saved example manifest checksum verified.</p>
    </section>
    <section className="space-y-3"><h2 ref={heading} tabIndex={-1} className="text-sm font-semibold focus-visible:outline-none">Saved findings</h2>
      <div aria-label="Public finding selection" className="grid gap-2 sm:grid-cols-2">{manifest.findings.map((value, index) => <button
        key={value.id} type="button" aria-pressed={finding.id === value.id} className={`min-w-0 rounded border p-3 text-left text-sm ${finding.id === value.id ? 'border-primary bg-primary/5' : 'border-border bg-surface'}`}
        onClick={() => select(value.id)}><span className="block font-medium">{index + 1}. {value.family === 'table' ? 'Count table' : 'Paired count figure'}</span>
        <span className="mt-1 block break-words text-xs text-textMuted">{value.caption}</span></button>)}</div>
      <FindingPreview key={finding.id} manifest={manifest} finding={finding} cached={records.current.get(finding.id)} onRecord={record} />
    </section>
    <section className="space-y-3 rounded border border-border bg-surface p-4 sm:p-5"><h2 className="text-sm font-semibold">How to read this example</h2>
      <p className="text-sm font-medium">{manifest.method.label}</p><p className="text-sm text-textMuted">{manifest.method.description}</p>
      <p className="text-sm text-textMuted">{manifest.limitations}</p>
    </section>
    <ExampleSource manifest={manifest} />
  </>;
}

export default function PublicSavedExample({ onOpenWorkspace }) {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } });
  const [attempt, setAttempt] = useState(0), [state, setState] = useState({ status: 'loading' }), generation = useRef(0);
  useEffect(() => {
    try { localStorage.setItem('theme', theme); } catch { /* Inspection does not require browser storage. */ }
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme');
  }, [theme]);
  useEffect(() => {
    const id = ++generation.current, controller = new AbortController();
    const current = () => id === generation.current && !controller.signal.aborted;
    setState({ status: 'loading' });
    void (async () => {
      try { const manifest = await loadPublicExampleManifest({ signal: controller.signal }); if (current()) setState({ status: 'ready', manifest }); }
      catch (error) { if (current()) setState({ status: 'error', kind: invalid(error) ? 'invalid' : 'unavailable' }); }
    })();
    return () => controller.abort();
  }, [attempt]);
  return <main aria-label="Public saved example" className="flex h-dvh min-h-0 min-w-0 flex-col bg-background text-text">
    <header className="shrink-0 border-b border-border bg-surface px-4 py-3 sm:px-8"><div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2"><Microscope size={22} className="text-primary" aria-hidden="true" /><div>
        <p className="text-sm font-semibold">TraceOmics</p><p className="text-xs text-textMuted">Public saved example · Synthetic</p></div></div>
      <div className="flex flex-wrap items-center gap-4"><button type="button" className="btn btn-secondary flex items-center gap-2 text-xs"
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}>
        {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}<span>Appearance</span>
      </button><button type="button" className="text-xs text-primary underline" onClick={onOpenWorkspace}>Open workspace</button></div>
    </div></header>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8"><div className="mx-auto max-w-5xl space-y-5 pb-8">
      {state.status === 'loading' && <section className="space-y-3"><h1 className="text-xl font-semibold">Public saved example</h1><p role="status" className="text-sm text-textMuted">Opening the saved example…</p></section>}
      {state.status === 'error' && <section className="space-y-3 rounded border border-border bg-surface p-4"><h1 className="text-xl font-semibold">{state.kind === 'invalid' ? 'The saved example could not be verified' : 'The saved example is unavailable'}</h1>
        <p role="alert" className="text-sm text-textMuted">{state.kind === 'invalid' ? 'The saved manifest did not match this example version. No findings have been opened.' : 'Check this app’s connection and try again. No sign-in or compute session is needed to inspect this public example.'}</p>
        <button type="button" className="btn btn-secondary text-sm" onClick={() => setAttempt(value => value + 1)}>Retry saved example</button></section>}
      {state.status === 'ready' && <ExampleContent manifest={state.manifest} />}
    </div></div>
  </main>;
}
