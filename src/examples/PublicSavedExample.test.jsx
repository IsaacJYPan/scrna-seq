import React from 'react';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PublicSavedExample from './PublicSavedExample';

// Exercise the real public transport, compiled pins and common result renderer.
// These are the tracked authored assets, not a private snapshot or test fixture.
const assets = Object.fromEntries(['manifest.json', 'table.json', 'figure.png', 'counts.csv'].map(file =>
  [file, readFileSync(new URL('../../public/examples/qc-retention/v1/' + file, import.meta.url))]));
const manifest = JSON.parse(assets['manifest.json'].toString('utf8')), csv = assets['counts.csv'].toString('utf8');
const originalAddress = window.location.href, NativeURL = globalThis.URL;
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const failure = () => { throw new Error('Private upstream path /secret must stay hidden'); };
let requests, overrides;
const response = (file, bytes = assets[file], status = 200) => new Response(bytes, { status,
  headers: { 'Content-Type': file.endsWith('.png') ? 'image/png' : file.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/json', 'Content-Length': String(bytes.byteLength) } });
const reads = file => requests.filter(request => request.file === file);
const tableButton = () => screen.getByRole('button', { name: /1\. Count table/ });
const figureButton = () => screen.getByRole('button', { name: /2\. Paired count figure/ });
const tableReady = () => screen.findByRole('cell', { name: 'Sample A' }, { timeout: 5000 });
const imageReady = () => screen.findByRole('img', { name: `Preview of ${manifest.findings[1].caption}` });

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); requests = []; overrides = {}; localStorage.clear(); sessionStorage.clear();
  document.documentElement.removeAttribute('data-theme'); window.history.replaceState(null, '', '/app/#/examples/qc-retention/v1');
  window.electronAPI = { restoreSession: vi.fn(), getCurrentTarget: vi.fn(), setTheme: vi.fn() };
  window.desktopShell = { getCurrentTarget: vi.fn() };
  let sequence = 0;
  vi.stubGlobal('URL', Object.assign(class extends NativeURL {}, { createObjectURL: vi.fn(() => `blob:public-example-${++sequence}`), revokeObjectURL: vi.fn() }));
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    const parsed = new NativeURL(url), file = parsed.pathname.split('/').at(-1), request = { file, url: parsed, options };
    requests.push(request);
    if (parsed.pathname !== '/app/examples/qc-retention/v1/' + file || !Object.hasOwn(assets, file)) throw new Error('Unexpected non-public request');
    return overrides[file] ? overrides[file](request) : response(file);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', originalAddress);
  delete window.electronAPI; delete window.desktopShell;
});

it('opens only the pinned public manifest and table with honest synthetic provenance, without account or compute observation', async () => {
  localStorage.setItem('auth_user', JSON.stringify({ id: 17, project: 'previous-private-selection' }));
  const getItem = vi.spyOn(Storage.prototype, 'getItem'), onOpenWorkspace = vi.fn();
  render(<PublicSavedExample onOpenWorkspace={onOpenWorkspace} />); await tableReady();
  expect(screen.getByRole('main', { name: 'Public saved example' })).toBeVisible();
  expect(screen.getByRole('heading', { level: 1, name: manifest.title })).toBeVisible(); expect(screen.getByText(manifest.question)).toBeVisible();
  expect(screen.getByText('Synthetic illustration · Version 1 · CC0-1.0')).toBeVisible();
  expect(screen.getByText(manifest.provenance.notice)).toBeVisible(); expect(screen.getByText(manifest.limitations)).toBeVisible();
  expect(screen.getByRole('cell', { name: '1000' })).toBeVisible(); expect(screen.getByRole('cell', { name: '850' })).toBeVisible();
  expect(screen.getByRole('cell', { name: 'Sample C' })).toBeVisible(); expect(screen.getAllByRole('table')).toHaveLength(1);
  expect(requests.map(value => value.file)).toEqual(['manifest.json', 'table.json']);
  expect(requests.every(value => value.options.method === 'GET' && value.options.credentials === 'omit'
    && value.options.mode === 'same-origin' && value.options.redirect === 'error')).toBe(true);
  expect(getItem.mock.calls.every(([key]) => key === 'theme')).toBe(true);
  expect(window.electronAPI.restoreSession).not.toHaveBeenCalled(); expect(window.electronAPI.getCurrentTarget).not.toHaveBeenCalled();
  expect(window.desktopShell.getCurrentTarget).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Run|Execute|Publish|Sign in|Start temporary demo|Next rows/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument(); expect(screen.queryByText(/CSV source checksum verified/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace' })); expect(onOpenWorkspace).toHaveBeenCalledOnce(); expect(requests).toHaveLength(2);
});

it('reads the figure only after selection and exposes a checked blob with an explicit full-size action', async () => {
  render(<PublicSavedExample />); await tableReady(); expect(reads('figure.png')).toHaveLength(0);
  fireEvent.click(figureButton()); const image = await imageReady();
  expect(image).toHaveAttribute('src', 'blob:public-example-1'); expect(reads('figure.png')).toHaveLength(1); expect(reads('counts.csv')).toHaveLength(0);
  expect(URL.createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob); expect(URL.createObjectURL.mock.calls[0][0].size).toBe(44517);
  const fullSize = screen.getByRole('link', { name: 'Open full-size image' }); expect(fullSize).toHaveAttribute('href', image.src);
  expect(fullSize).toHaveAttribute('target', '_blank'); expect(fullSize).toHaveAttribute('rel', 'noopener noreferrer');
  expect(fullSize).not.toHaveAttribute('download');
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Saved findings' })).toHaveFocus());
  fireEvent.click(screen.getByText('Exact source and saved view'));
  expect(screen.getByText('Recorded CSV source SHA-256')).toBeVisible(); expect(screen.getByText('Verified payload SHA-256')).toBeVisible();
  expect(screen.getByText(manifest.findings[1].asset.sha256)).toBeVisible(); expect(screen.getByText(manifest.findings[1].sourceSha256)).toBeVisible();
  expect(screen.getByText(manifest.findings[1].viewSha256)).toBeVisible();
});

it('keeps verified results in memory, revokes image URLs on selection/unmount, and never reloads the table after a figure visit', async () => {
  const view = render(<PublicSavedExample />); await tableReady(); fireEvent.click(figureButton()); await imageReady();
  fireEvent.click(tableButton()); await tableReady(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:public-example-1');
  expect(reads('table.json')).toHaveLength(1); fireEvent.click(figureButton()); expect(await imageReady()).toHaveAttribute('src', 'blob:public-example-2');
  expect(reads('figure.png')).toHaveLength(1); view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:public-example-2');
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});

it('keeps a checked table and question available when the figure is unavailable and retries only by explicit action', async () => {
  overrides['figure.png'] = failure; render(<PublicSavedExample />); await tableReady(); fireEvent.click(figureButton());
  expect(await screen.findByText('This saved finding is unavailable. Choose another finding or retry this one.')).toBeVisible();
  expect(screen.getByText(manifest.question)).toBeVisible(); expect(screen.queryByText(/Private upstream/)).not.toBeInTheDocument();
  fireEvent.click(tableButton()); await tableReady(); expect(reads('table.json')).toHaveLength(1);
  fireEvent.click(figureButton()); await screen.findByRole('button', { name: 'Retry finding' }); expect(reads('figure.png')).toHaveLength(1);
  delete overrides['figure.png']; fireEvent.click(screen.getByRole('button', { name: 'Retry finding' })); await imageReady();
  expect(reads('figure.png')).toHaveLength(2); expect(reads('counts.csv')).toHaveLength(0);
});

it('keeps a valid figure inspectable after the table fails, without treating manifest admission as table verification', async () => {
  overrides['table.json'] = failure; render(<PublicSavedExample />);
  await screen.findByRole('button', { name: 'Retry finding' });
  expect(screen.queryByText('Selected payload and view descriptor checksums verified.')).not.toBeInTheDocument();
  expect(screen.getByText('Recorded payload SHA-256')).toBeInTheDocument();
  fireEvent.click(figureButton()); await imageReady(); expect(screen.getByText(manifest.question)).toBeVisible();
  fireEvent.click(tableButton()); await screen.findByRole('button', { name: 'Retry finding' }); expect(reads('table.json')).toHaveLength(1);
  delete overrides['table.json']; fireEvent.click(screen.getByRole('button', { name: 'Retry finding' })); await tableReady();
  expect(reads('table.json')).toHaveLength(2);
});

it('withholds corrupt PNG bytes before blob creation, then recovers only after an explicit checked retry', async () => {
  const broken = Buffer.from(assets['figure.png']); broken[100] ^= 1; overrides['figure.png'] = () => response('figure.png', broken);
  render(<PublicSavedExample />); await tableReady(); fireEvent.click(figureButton());
  expect(await screen.findByText('This saved finding could not be verified. No preview is shown.')).toBeVisible();
  expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByText('Recorded payload SHA-256')).toBeInTheDocument();
  delete overrides['figure.png']; fireEvent.click(screen.getByRole('button', { name: 'Retry finding' })); await imageReady();
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
});

it('removes a failed decoded image and its full-size link while reporting the payload verification honestly', async () => {
  render(<PublicSavedExample />); await tableReady(); fireEvent.click(figureButton()); const image = await imageReady();
  fireEvent.error(image);
  expect(screen.getByText('The figure bytes were verified, but the image could not be displayed.')).toBeVisible();
  expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(screen.queryByRole('link', { name: 'Open full-size image' })).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:public-example-1');
  fireEvent.click(screen.getByRole('button', { name: 'Retry finding' })); expect(await imageReady()).toHaveAttribute('src', 'blob:public-example-2');
  expect(reads('figure.png')).toHaveLength(2);
});

it('keeps a blob-creation failure local even when returning to a previously checked cached figure', async () => {
  render(<PublicSavedExample />); await tableReady(); fireEvent.click(figureButton()); await imageReady(); fireEvent.click(tableButton()); await tableReady();
  URL.createObjectURL.mockImplementationOnce(() => { throw new Error('private blob provider'); }); fireEvent.click(figureButton());
  expect(await screen.findByText('The figure bytes were verified, but the image could not be displayed.')).toBeVisible();
  expect(screen.queryByText(/private blob provider/)).not.toBeInTheDocument(); expect(screen.getByText(manifest.question)).toBeVisible();
  fireEvent.click(tableButton()); await tableReady(); expect(reads('table.json')).toHaveLength(1);
});

it.each(['unavailable', 'corrupt'])('distinguishes a %s manifest from an admitted example and never requests findings before an explicit successful retry', async kind => {
  overrides['manifest.json'] = kind === 'unavailable' ? failure : () => response('manifest.json', Buffer.from('{}'));
  render(<PublicSavedExample />); expect(await screen.findByRole('heading', { name: kind === 'unavailable' ? 'The saved example is unavailable' : 'The saved example could not be verified' })).toBeVisible();
  expect(reads('table.json')).toHaveLength(0); expect(reads('figure.png')).toHaveLength(0); expect(reads('counts.csv')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: /Sign in|Start temporary demo/ })).not.toBeInTheDocument();
  delete overrides['manifest.json']; fireEvent.click(screen.getByRole('button', { name: 'Retry saved example' })); await tableReady();
  expect(reads('manifest.json')).toHaveLength(2); expect(reads('table.json')).toHaveLength(1);
});

it('fetches and checks the exact authored CSV only after an explicit source action, without confusing its recorded identity with downloaded bytes', async () => {
  render(<PublicSavedExample />); await tableReady(); expect(reads('counts.csv')).toHaveLength(0);
  expect(screen.queryByText(/CSV source checksum verified/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'View CSV source' }));
  expect((await screen.findByLabelText('Verified public CSV source')).textContent).toBe(csv);
  expect(screen.getByText('CSV source checksum verified · 87 bytes fetched.')).toBeVisible();
  expect(screen.getByText('Verified CSV source SHA-256')).toBeVisible(); expect(reads('counts.csv')).toHaveLength(1);
  expect(reads('counts.csv')[0].options.credentials).toBe('omit');
  fireEvent.click(screen.getByRole('button', { name: 'Hide CSV source' })); expect(screen.queryByLabelText('Verified public CSV source')).not.toBeInTheDocument();
  expect(screen.queryByText(/CSV source checksum verified/)).not.toBeInTheDocument();
});

it.each(['unavailable', 'corrupt'])('keeps a %s optional CSV local, preserves the checked table and offers a deliberate source retry', async kind => {
  overrides['counts.csv'] = kind === 'unavailable' ? failure : () => response('counts.csv', Buffer.from('<img src=x onerror=alert(1)>'));
  render(<PublicSavedExample />); await tableReady(); fireEvent.click(screen.getByRole('button', { name: 'View CSV source' }));
  await screen.findByRole('button', { name: 'Retry CSV source' }); expect(screen.getByRole('table')).toBeVisible();
  expect(screen.queryByLabelText('Verified public CSV source')).not.toBeInTheDocument(); expect(screen.queryByText(/CSV source checksum verified/)).not.toBeInTheDocument();
  expect(document.querySelector('img')).toBeNull(); expect(screen.getByText(manifest.question)).toBeVisible();
  delete overrides['counts.csv']; fireEvent.click(screen.getByRole('button', { name: 'Retry CSV source' })); await screen.findByLabelText('Verified public CSV source');
  expect(reads('counts.csv')).toHaveLength(2); expect(reads('table.json')).toHaveLength(1);
});

it('aborts a held image read on selection change and never creates a blob or caches its late reply', async () => {
  const held = deferred(); overrides['figure.png'] = () => held.promise;
  render(<PublicSavedExample />); await tableReady(); fireEvent.click(figureButton()); await waitFor(() => expect(reads('figure.png')).toHaveLength(1));
  const signal = reads('figure.png')[0].options.signal; fireEvent.click(tableButton()); await tableReady(); expect(signal.aborted).toBe(true);
  await act(async () => held.resolve(response('figure.png'))); expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(screen.queryByRole('img')).not.toBeInTheDocument();
  delete overrides['figure.png']; fireEvent.click(figureButton()); await imageReady(); expect(reads('figure.png')).toHaveLength(2);
});

it('cancels held manifest work on unmount so an older success cannot start any finding request', async () => {
  const held = deferred(); overrides['manifest.json'] = () => held.promise; const view = render(<PublicSavedExample />);
  await waitFor(() => expect(reads('manifest.json')).toHaveLength(1)); const signal = reads('manifest.json')[0].options.signal;
  view.unmount(); expect(signal.aborted).toBe(true); await act(async () => held.resolve(response('manifest.json')));
  expect(reads('table.json')).toHaveLength(0); expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('aborts an in-flight figure when the public page closes and never creates a late object URL', async () => {
  const held = deferred(); overrides['figure.png'] = () => held.promise;
  const view = render(<PublicSavedExample />); await tableReady(); fireEvent.click(figureButton());
  await waitFor(() => expect(reads('figure.png')).toHaveLength(1)); const signal = reads('figure.png')[0].options.signal;
  view.unmount(); expect(signal.aborted).toBe(true); await act(async () => held.resolve(response('figure.png')));
  expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(reads('counts.csv')).toHaveLength(0);
});

it('shows recorded payload identity while the selected table is pending and claims verification only when its actual bytes arrive', async () => {
  const held = deferred(); overrides['table.json'] = () => held.promise; render(<PublicSavedExample />);
  await screen.findByText('Saved example manifest checksum verified.');
  await waitFor(() => expect(reads('table.json')).toHaveLength(1));
  expect(screen.getByText('Recorded payload SHA-256')).toBeInTheDocument();
  expect(screen.queryByText('Verified payload SHA-256')).not.toBeInTheDocument();
  expect(screen.queryByText('Selected payload and view descriptor checksums verified.')).not.toBeInTheDocument();
  expect(reads('counts.csv')).toHaveLength(0); await act(async () => held.resolve(response('table.json'))); await tableReady();
  expect(screen.getByText('Verified payload SHA-256')).toBeInTheDocument(); expect(screen.getByText('Selected payload and view descriptor checksums verified.')).toBeVisible();
});

it('cancels a hidden CSV request and cannot show its late source or checksum after the source is closed', async () => {
  const held = deferred(); overrides['counts.csv'] = () => held.promise; render(<PublicSavedExample />); await tableReady();
  fireEvent.click(screen.getByRole('button', { name: 'View CSV source' })); await waitFor(() => expect(reads('counts.csv')).toHaveLength(1));
  const signal = reads('counts.csv')[0].options.signal; fireEvent.click(screen.getByRole('button', { name: 'Hide CSV source' })); expect(signal.aborted).toBe(true);
  await act(async () => held.resolve(response('counts.csv'))); expect(screen.queryByLabelText('Verified public CSV source')).not.toBeInTheDocument();
  expect(screen.queryByText(/CSV source checksum verified/)).not.toBeInTheDocument(); expect(screen.getByRole('table')).toBeVisible();
  delete overrides['counts.csv']; fireEvent.click(screen.getByRole('button', { name: 'View CSV source' })); await screen.findByLabelText('Verified public CSV source');
  expect(reads('counts.csv')).toHaveLength(2);
});

it('keeps optional source inspection independent of finding selection and never re-fetches it just to show the figure', async () => {
  render(<PublicSavedExample />); await tableReady(); fireEvent.click(screen.getByRole('button', { name: 'View CSV source' })); await screen.findByLabelText('Verified public CSV source');
  fireEvent.click(figureButton()); await imageReady(); expect(screen.getByLabelText('Verified public CSV source')).toHaveTextContent('Sample C,800,720');
  expect(reads('counts.csv')).toHaveLength(1); expect(within(screen.getByLabelText('Public example CSV source')).getByRole('button', { name: 'Hide CSV source' })).toBeVisible();
});

it('uses only the local theme preference, retains checked content through appearance changes and persists no example payload', async () => {
  localStorage.setItem('theme', 'dark'); const writes = vi.spyOn(Storage.prototype, 'setItem'); render(<PublicSavedExample />); await tableReady();
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark'); fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
  expect(document.documentElement).not.toHaveAttribute('data-theme'); expect(writes.mock.calls.every(([key]) => key === 'theme')).toBe(true);
  expect(Object.keys(localStorage)).toEqual(['theme']); expect(sessionStorage.length).toBe(0); expect(reads('table.json')).toHaveLength(1);
  expect(window.electronAPI.setTheme).not.toHaveBeenCalled(); expect(window.desktopShell.getCurrentTarget).not.toHaveBeenCalled();
});

it('does not require browser storage to inspect the public example or change its appearance', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage disabled'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled'); });
  render(<PublicSavedExample />); await tableReady(); fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark'); expect(screen.getByRole('table')).toBeVisible();
});
