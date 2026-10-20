import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ResearchAnalyses from './ResearchAnalyses';
import { createAnalysis, getAnalysis, listAnalyses, listReferenceOptions, listExistingWork, updateAnalysis } from '../analyses/researchAnalysisApi';

vi.mock('../analyses/researchAnalysisApi', () => ({
  createAnalysis: vi.fn(), getAnalysis: vi.fn(), listAnalyses: vi.fn(), listReferenceOptions: vi.fn(), updateAnalysis: vi.fn(), listExistingWork: vi.fn(),
}));

const reference = { kind: 'artifact-version', versionId: `av_${'b'.repeat(24)}`, sha256: 'c'.repeat(64) };
const first = { id: `ra_${'a'.repeat(24)}`, projectId: 'project_one', name: 'Treatment response', description: 'Compare samples.',
  version: 1, status: 'active', references: [{ reference, access: 'available' }], updatedAt: '2026-10-20T12:00:00Z' };
const second = { ...first, id: `ra_${'d'.repeat(24)}`, name: 'Cell annotation', description: 'Review markers.', references: [] };
const defaults = { userId: 1, projectId: 'project_one', projectName: 'Immune cohort', role: 'analyst', isActive: true };
let savedAnalyses;
const panel = () => screen.getByRole('region', { name: 'Selected analysis' });
const editor = name => within(panel()).getByRole('textbox', { name });
const open = async name => {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }));
  await waitFor(() => expect(editor('Analysis name')).toHaveValue(name));
};

beforeEach(() => {
  vi.resetAllMocks(); savedAnalyses = [first, second];
  listAnalyses.mockImplementation(async (_projectId, { status }) => ({ analyses: savedAnalyses.filter(item => item.status === status), nextCursor: null }));
  getAnalysis.mockImplementation(async (_projectId, id) => ({ analysis: savedAnalyses.find(item => item.id === id) }));
  createAnalysis.mockImplementation(async (_projectId, input) => {
    const analysis = { ...first, id: `ra_${'e'.repeat(24)}`, name: input.name, description: input.description || '', references: (input.references || []).map(reference => ({ reference, access: 'available' })) };
    savedAnalyses = [analysis, ...savedAnalyses]; return { analysis };
  });
  updateAnalysis.mockImplementation(async (_projectId, id, input) => {
    const { expectedVersion, ...patch } = input;
    const analysis = { ...savedAnalyses.find(item => item.id === id), ...patch, version: expectedVersion + 1,
      references: input.references.map(item => ({ reference: item, access: 'available' })) };
    savedAnalyses = savedAnalyses.map(item => item.id === id ? analysis : item);
    return { analysis };
  });
  listReferenceOptions.mockResolvedValue({ options: [{ reference, label: 'Cell metadata.csv', type: 'table' }], nextCursor: null });
  listExistingWork.mockResolvedValue({ projectId: 'project_one', kind: 'objects', items: [{ id: 'ao_' + 'f'.repeat(24), kind: 'analysis-object',
    label: 'Established donor work', type: 'seurat', ownerUserId: 1, ownership: 'yours', reference, savedState: 'recorded', liveState: 'not-checked', createdAt: first.updatedAt }], nextCursor: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('durable project analyses', () => {
  it('adopts an exact saved version through the analysis entry without losing another question draft', async () => {
    render(<ResearchAnalyses {...defaults} />); await open(first.name);
    fireEvent.change(editor('Research question or notes'), { target: { value: 'Keep this unsaved question.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bring saved work' }));
    const browser = await screen.findByRole('region', { name: 'Existing saved work' });
    fireEvent.click(await within(browser).findByRole('button', { name: /^Established donor work/ }));
    fireEvent.click(within(browser).getByRole('button', { name: 'Start analysis with this saved version' }));
    await screen.findByText('Analysis created from the exact saved version. Original source access is unchanged.');
    expect(createAnalysis.mock.calls[0][1].references).toEqual([reference]);
    expect(editor('Analysis name')).toHaveValue('Established donor work');
    expect(within(panel()).getByText(/Exact version linked/)).toBeVisible();
    await open(first.name); expect(editor('Research question or notes')).toHaveValue('Keep this unsaved question.');
  });

  it('opens original object history deliberately without creating an analysis or altering its saved source', async () => {
    const original = vi.fn().mockResolvedValue(undefined);
    render(<ResearchAnalyses {...defaults} onOpenOriginal={original} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bring saved work' }));
    const browser = await screen.findByRole('region', { name: 'Existing saved work' });
    fireEvent.click(await within(browser).findByRole('button', { name: /^Established donor work/ }));
    fireEvent.click(within(browser).getByRole('button', { name: 'Open original object history' }));
    await waitFor(() => expect(original).toHaveBeenCalledWith('ao_' + 'f'.repeat(24)));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Existing saved work' })).toBeNull());
    expect(createAnalysis).not.toHaveBeenCalled(); expect(updateAnalysis).not.toHaveBeenCalled();
  });

  it('opens a different desktop analysis at the start of its detail while retaining the list position', async () => {
    vi.stubGlobal('innerWidth', 1366);
    render(<ResearchAnalyses {...defaults} />);
    await open(first.name);
    const list = screen.getByRole('list', { name: 'Analysis list' });
    list.scrollTop = 430; panel().scrollTop = 250;
    await open(second.name);
    expect(panel().scrollTop).toBe(0);
    expect(list.scrollTop).toBe(430);
    expect(editor('Research question or notes')).toHaveValue(second.description);
    panel().scrollTop = 270;
    await open(second.name);
    expect(panel().scrollTop).toBe(0);
    expect(list.scrollTop).toBe(430);
    expect(updateAnalysis).not.toHaveBeenCalled();
  });

  it('moves mobile focus to the selected analysis and returns to its list position without losing a draft', async () => {
    vi.stubGlobal('innerWidth', 390);
    render(<ResearchAnalyses {...defaults} />);
    const row = await screen.findByRole('button', { name: new RegExp(first.name) });
    const scroller = screen.getByRole('region', { name: 'Project analyses' }).closest('.overflow-auto');
    scroller.scrollTop = 430;
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByRole('button', { name: 'All analyses' })).toHaveFocus());
    expect(scroller.scrollTop).toBe(0);
    fireEvent.change(editor('Research question or notes'), { target: { value: 'My mobile draft.' } });
    fireEvent.click(screen.getByRole('button', { name: 'All analyses' }));
    expect(row).toHaveFocus();
    expect(scroller.scrollTop).toBe(430);
    await open(first.name);
    expect(editor('Research question or notes')).toHaveValue('My mobile draft.');
    expect(createAnalysis).not.toHaveBeenCalled(); expect(updateAnalysis).not.toHaveBeenCalled();
  });

  it('requires an explicit project and gives viewers a read-only analysis', async () => {
    const choose = vi.fn();
    const view = render(<ResearchAnalyses {...defaults} projectId={null} onOpenWorkspace={choose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a project' }));
    expect(choose).toHaveBeenCalledOnce(); expect(listAnalyses).not.toHaveBeenCalled();
    view.rerender(<ResearchAnalyses {...defaults} role="viewer" />);
    await open(first.name);
    expect(editor('Analysis name')).toHaveAttribute('readonly');
    expect(editor('Research question or notes')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'New analysis' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(updateAnalysis).not.toHaveBeenCalled();
  });

  it('retries an uncertain creation with the identical UUID and payload, then opens the created analysis', async () => {
    createAnalysis.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<ResearchAnalyses {...defaults} />);
    await open(first.name);
    fireEvent.click(screen.getByRole('button', { name: 'New analysis', exact: true }));
    const form = screen.getByRole('form', { name: 'New analysis' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Analysis name' }), { target: { value: 'New scientific question' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create analysis' }));
    await screen.findByText(/Creation could not be confirmed/);
    expect(within(form).getByRole('textbox', { name: 'Analysis name' })).toBeDisabled();
    const originalPayload = createAnalysis.mock.calls[0][1];
    expect(originalPayload.requestId).toMatch(/^[a-f0-9-]{36}$/);
    fireEvent.click(within(form).getByRole('button', { name: 'Retry create' }));
    await waitFor(() => expect(editor('Analysis name')).toHaveValue('New scientific question'));
    expect(createAnalysis.mock.calls[1][1]).toEqual(originalPayload);
    expect(screen.getAllByRole('button', { name: /New scientific question/ })).toHaveLength(1);
  });

  it('keeps edited source through a conflict and rebases only after an explicit choice', async () => {
    const latest = { ...first, version: 2, name: 'Colleague question', description: 'Colleague notes.' };
    updateAnalysis.mockRejectedValueOnce(Object.assign(new Error('Stale edit'), { code: 'ANALYSIS_VERSION_CONFLICT', analysis: latest }));
    render(<ResearchAnalyses {...defaults} />);
    await open(first.name);
    fireEvent.change(editor('Analysis name'), { target: { value: 'My edited question' } });
    fireEvent.change(editor('Research question or notes'), { target: { value: 'My interpretation.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('region', { name: 'Newer saved version' });
    expect(editor('Analysis name')).toHaveValue('My edited question');
    expect(editor('Research question or notes')).toHaveValue('My interpretation.');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(updateAnalysis.mock.calls[0][2]).toMatchObject({ expectedVersion: 1, references: [reference] });
    fireEvent.click(screen.getByRole('button', { name: 'Keep my edits with latest saved work' }));
    expect(editor('Analysis name')).toHaveValue('My edited question');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved. Previous revisions are retained.');
    expect(updateAnalysis.mock.calls[1][2]).toMatchObject({ expectedVersion: 2, name: 'My edited question', description: 'My interpretation.', references: [reference] });
  });

  it('preserves drafts while opening another analysis and ignores a delayed earlier selection', async () => {
    render(<ResearchAnalyses {...defaults} />);
    await open(first.name);
    fireEvent.change(editor('Research question or notes'), { target: { value: 'My unsaved finding.' } });
    await open(second.name);
    await open(first.name);
    expect(editor('Research question or notes')).toHaveValue('My unsaved finding.');
    expect(updateAnalysis).not.toHaveBeenCalled();
    let reply;
    getAnalysis.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(first.name) }));
    await open(second.name);
    await act(async () => { reply({ analysis: first }); });
    expect(editor('Analysis name')).toHaveValue(second.name);
    expect(editor('Research question or notes')).toHaveValue(second.description);
  });

  it('links an exact chosen version without submitting read-only access metadata or copying data', async () => {
    render(<ResearchAnalyses {...defaults} />);
    await open(second.name);
    fireEvent.click(screen.getByRole('button', { name: 'Link saved material' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Cell metadata.csv/ }));
    expect(updateAnalysis).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved. Previous revisions are retained.');
    expect(updateAnalysis).toHaveBeenCalledWith('project_one', second.id, expect.objectContaining({ references: [reference] }));
    expect(JSON.stringify(updateAnalysis.mock.calls[0][2])).not.toContain('access');
    expect(within(screen.getByRole('region', { name: 'Linked material' })).getByRole('button', { name: /Unlink Cell metadata.csv/ })).toBeVisible();
  });

  it('does not let an earlier selection read replace a successfully saved revision', async () => {
    let reply;
    getAnalysis.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    render(<ResearchAnalyses {...defaults} />);
    await open(first.name);
    fireEvent.change(editor('Research question or notes'), { target: { value: 'New confirmed interpretation.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved. Previous revisions are retained.');
    await act(async () => { reply({ analysis: first }); });
    expect(editor('Research question or notes')).toHaveValue('New confirmed interpretation.');
    expect(within(panel()).getByText(/^Version 2/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('does not let an earlier selection read switch away from a newly created analysis', async () => {
    let reply;
    getAnalysis.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    render(<ResearchAnalyses {...defaults} />);
    await open(first.name);
    fireEvent.click(screen.getByRole('button', { name: 'New analysis', exact: true }));
    const form = screen.getByRole('form', { name: 'New analysis' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Analysis name' }), { target: { value: 'New scientific question' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create analysis' }));
    await waitFor(() => expect(editor('Analysis name')).toHaveValue('New scientific question'));
    await act(async () => { reply({ analysis: first }); });
    expect(editor('Analysis name')).toHaveValue('New scientific question');
    expect(editor('Research question or notes')).toHaveValue('');
  });

  it('retains archived work and deliberately restores its next revision', async () => {
    render(<ResearchAnalyses {...defaults} />);
    await open(first.name);
    fireEvent.click(screen.getByRole('button', { name: 'Archive', exact: true }));
    await screen.findByText('Analysis archived. It remains available under Archived.');
    expect(editor('Analysis name')).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button', { name: 'Restore analysis' }));
    await screen.findByText('Changes saved. Previous revisions are retained.');
    expect(updateAnalysis.mock.calls[1][2]).toMatchObject({ expectedVersion: 2, status: 'active' });
    expect(editor('Analysis name')).not.toHaveAttribute('readonly');
  });

  it('merges untouched colleague fields and reference additions while retaining my edited notes', async () => {
    const colleagueReference = { ...reference, versionId: `av_${'f'.repeat(24)}` };
    const latest = { ...first, version: 2, name: 'Colleague title', references: [...first.references, { reference: colleagueReference, access: 'restricted' }] };
    updateAnalysis.mockRejectedValueOnce(Object.assign(new Error('Stale edit'), { code: 'ANALYSIS_VERSION_CONFLICT', analysis: latest }));
    render(<ResearchAnalyses {...defaults} />);
    await open(first.name);
    fireEvent.change(editor('Research question or notes'), { target: { value: 'My new interpretation.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('region', { name: 'Newer saved version' });
    expect(screen.getByText('Linked material in this version: 2')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep my edits with latest saved work' }));
    expect(editor('Analysis name')).toHaveValue('Colleague title');
    expect(editor('Research question or notes')).toHaveValue('My new interpretation.');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved. Previous revisions are retained.');
    expect(updateAnalysis.mock.calls[1][2]).toMatchObject({ expectedVersion: 2, name: 'Colleague title', references: [reference, colleagueReference] });
  });

  it('does not let a delayed initial listing hide a newly created analysis', async () => {
    let reply;
    listAnalyses.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    render(<ResearchAnalyses {...defaults} />);
    await waitFor(() => expect(listAnalyses).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'New analysis', exact: true }));
    const form = screen.getByRole('form', { name: 'New analysis' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Analysis name' }), { target: { value: 'New scientific question' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create analysis' }));
    await screen.findByRole('button', { name: /New scientific question/ });
    await act(async () => { reply({ analyses: [], nextCursor: null }); });
    expect(screen.getByRole('button', { name: /New scientific question/ })).toBeVisible();
    expect(editor('Analysis name')).toHaveValue('New scientific question');
  });

  it('does not let a delayed pre-save refresh restore an older card or selected revision', async () => {
    render(<ResearchAnalyses {...defaults} />);
    await open(first.name);
    let reply;
    listAnalyses.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh analyses' }));
    await waitFor(() => expect(listAnalyses).toHaveBeenCalledTimes(2));
    fireEvent.change(editor('Research question or notes'), { target: { value: 'Latest interpretation.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved. Previous revisions are retained.');
    await act(async () => { reply({ analyses: [first, second], nextCursor: null }); });
    expect(screen.getByRole('button', { name: new RegExp(first.name) })).toHaveTextContent('Version 2');
    expect(editor('Research question or notes')).toHaveValue('Latest interpretation.');
  });

  it('keeps a newer server observation when an earlier save acknowledgment arrives later', async () => {
    let replyToRead, replyToSave;
    getAnalysis.mockImplementationOnce(() => new Promise(resolve => { replyToRead = resolve; }));
    updateAnalysis.mockImplementationOnce(() => new Promise(resolve => { replyToSave = resolve; }));
    render(<ResearchAnalyses {...defaults} />);
    await open(first.name);
    fireEvent.change(editor('Research question or notes'), { target: { value: 'Saved as revision two.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(replyToSave).toBeTypeOf('function'));
    const latest = { ...first, version: 3, description: 'Later colleague revision.' };
    savedAnalyses = [latest, second];
    await act(async () => { replyToRead({ analysis: latest }); });
    await act(async () => { replyToSave({ analysis: { ...first, version: 2, description: 'Saved as revision two.' } }); });
    await screen.findByText('Changes saved. Previous revisions are retained.');
    expect(within(panel()).getByText(/^Version 3/)).toBeVisible();
    expect(editor('Research question or notes')).toHaveValue('Later colleague revision.');
    expect(screen.getByRole('button', { name: new RegExp(first.name) })).toHaveTextContent('Version 3');
  });

  it('combines local link additions and colleague removals instead of restoring an old source', async () => {
    const local = { ...reference, versionId: `av_${'1'.repeat(24)}` };
    const remote = { ...reference, versionId: `av_${'2'.repeat(24)}` };
    const latest = { ...first, version: 2, references: [{ reference: remote, access: 'restricted' }] };
    listReferenceOptions.mockResolvedValue({ options: [{ reference: local, label: 'Local table', type: 'table' }], nextCursor: null });
    updateAnalysis.mockRejectedValueOnce(Object.assign(new Error('Stale edit'), { code: 'ANALYSIS_VERSION_CONFLICT', analysis: latest }));
    render(<ResearchAnalyses {...defaults} />);
    await open(first.name);
    fireEvent.click(screen.getByRole('button', { name: 'Link saved material' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Local table/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('region', { name: 'Newer saved version' });
    fireEvent.click(screen.getByRole('button', { name: 'Keep my edits with latest saved work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved. Previous revisions are retained.');
    expect(updateAnalysis.mock.calls[1][2].references).toEqual([remote, local]);
  });

  it('caps added links without blocking removal of an existing link', async () => {
    const many = Array.from({ length: 50 }, (_, index) => ({ ...reference, versionId: `av_${index.toString(16).padStart(24, '0')}` }));
    savedAnalyses = [{ ...first, references: many.map(item => ({ reference: item, access: 'available' })) }];
    listReferenceOptions.mockResolvedValue({ options: [
      { reference: many[0], label: 'Original source', type: 'table' },
      { reference, label: 'Additional source', type: 'table' },
    ], nextCursor: null });
    render(<ResearchAnalyses {...defaults} />);
    await open(first.name);
    fireEvent.click(screen.getByRole('button', { name: 'Link saved material' }));
    const extra = await screen.findByRole('checkbox', { name: /Additional source/ });
    expect(extra).toBeDisabled();
    const original = screen.getByRole('checkbox', { name: /Original source/ });
    expect(original).toBeEnabled(); fireEvent.click(original);
    expect(extra).toBeEnabled(); fireEvent.click(extra);
    expect(screen.getByText('50 of 50 saved links')).toBeVisible();
  });

  it('clears the previous project view and fences its delayed reply when project context changes', async () => {
    let reply;
    listAnalyses.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const view = render(<ResearchAnalyses {...defaults} />);
    await waitFor(() => expect(listAnalyses).toHaveBeenCalledOnce());
    listAnalyses.mockResolvedValue({ analyses: [{ ...second, projectId: 'project_two' }], nextCursor: null });
    view.rerender(<ResearchAnalyses {...defaults} projectId="project_two" projectName="Different cohort" />);
    await screen.findByRole('button', { name: new RegExp(second.name) });
    await act(async () => { reply({ analyses: [first], nextCursor: null }); });
    expect(screen.queryByRole('button', { name: new RegExp(first.name) })).toBeNull();
    expect(screen.getByText('Different cohort')).toBeVisible();
  });
});
