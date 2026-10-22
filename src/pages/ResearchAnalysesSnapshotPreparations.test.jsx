import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ResearchAnalyses from './ResearchAnalyses';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { createAnalysis, getAnalysis, listAnalyses, updateAnalysis } from '../analyses/researchAnalysisApi';

vi.mock('../runtime/useExecutionTarget', () => ({ default: vi.fn() }));
vi.mock('../analyses/researchAnalysisApi', () => ({ createAnalysis: vi.fn(), getAnalysis: vi.fn(), listAnalyses: vi.fn(), updateAnalysis: vi.fn(),
  listReferenceOptions: vi.fn(), listExistingWork: vi.fn() }));
vi.mock('../analyses/AnalysisSnapshotPreparations', () => ({ default: function Preparation(props) {
  const [draft, setDraft] = React.useState('');
  return <section aria-label="Mock private preparation" data-analysis={props.analysisId} data-user={props.userId}
    data-active={props.isActive} data-available={props.available} data-writable={props.canWrite}>
    <output aria-label="Preparation saved context">{props.savedAnalysis.name} · saved {props.savedAnalysis.version} · {props.overviewDirty ? 'overview edited' : 'overview saved'}</output>
    <input aria-label="Private preparation draft" disabled={!props.available || !props.isActive || !props.canWrite} value={draft} onChange={event => setDraft(event.target.value)} />
    <button type="button" onClick={props.onBack}>Back to analysis overview</button>
    <button type="button" onClick={props.onReturnToSave}>Return to save changes</button>
  </section>;
} }));
vi.mock('../notebooks/NotebookWorkspace', () => ({ default: function Notebook(props) {
  const [source, setSource] = React.useState('');
  return <section aria-label="Mock notebook workspace"><input aria-label="Unsent notebook source" value={source} onChange={event => setSource(event.target.value)} />
    <button type="button" onClick={props.onOpenOverview}>Back from documents</button></section>;
} }));
vi.mock('../analyses/AnalysisAttachments', () => ({ default: function Attachments(props) {
  const [source, setSource] = React.useState('');
  return <section aria-label="Mock outside result context"><input aria-label="Chosen outside source" value={source} onChange={event => setSource(event.target.value)} />
    <button type="button" onClick={props.onClose}>Back from outside results</button></section>;
} }));

const first = { id: 'ra_' + 'a'.repeat(24), projectId: 'project_one', name: 'Treatment response', description: 'Compare samples.',
  version: 1, status: 'active', references: [], updatedAt: '2026-10-22T12:00:00.000Z' };
const second = { ...first, id: 'ra_' + 'b'.repeat(24), name: 'Cell annotation', description: 'Review markers.' };
const defaults = { userId: 1, projectId: 'project_one', projectName: 'Immune cohort', role: 'analyst', isActive: true };
const connection = { identity: 'workspace-one', epoch: 1, blocked: false };
const overview = () => screen.getByRole('region', { name: 'Selected analysis' });
const question = () => within(overview()).getByRole('textbox', { name: 'Research question or notes' });
const preparation = () => screen.getByRole('region', { name: 'Mock private preparation' });
const preparationDraft = () => within(preparation()).getByRole('textbox', { name: 'Private preparation draft' });
let saved;
async function openAnalysis(value = first) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp('^' + value.name) }));
  await waitFor(() => expect(within(overview()).getByRole('textbox', { name: 'Analysis name' })).toHaveValue(value.name));
}
async function enterPreparation(label = 'Prepare sharing') {
  fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
  await screen.findByRole('region', { name: 'Mock private preparation' });
}
async function back() {
  fireEvent.click(within(preparation()).getByRole('button', { name: 'Back to analysis overview' }));
  await waitFor(() => expect(screen.getByRole('button', { name: /^(Prepare sharing|Saved preparations)$/ })).toHaveFocus());
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('innerWidth', 1366); saved = [first, second]; useExecutionTarget.mockReturnValue(connection);
  listAnalyses.mockImplementation(async (projectId, { status }) => ({ analyses: saved.filter(item => item.status === status).map(item => ({ ...item, projectId })), nextCursor: null }));
  getAnalysis.mockImplementation(async (projectId, id) => ({ analysis: { ...saved.find(item => item.id === id), projectId } }));
});
afterEach(() => vi.unstubAllGlobals());

it('keeps a dirty overview and private preparation draft across ordinary back/reopen without saving or substituting draft text for saved analysis', async () => {
  render(<ResearchAnalyses {...defaults} />); await openAnalysis();
  fireEvent.change(question(), { target: { value: 'Unsent scientific interpretation.' } }); await enterPreparation();
  expect(within(preparation()).getByLabelText('Preparation saved context')).toHaveTextContent('Treatment response · saved 1 · overview edited');
  fireEvent.change(preparationDraft(), { target: { value: 'Private selected evidence notes.' } }); await back();
  expect(question()).toHaveValue('Unsent scientific interpretation.'); expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  await enterPreparation(); expect(preparationDraft()).toHaveValue('Private selected evidence notes.');
  expect(updateAnalysis).not.toHaveBeenCalled(); expect(createAnalysis).not.toHaveBeenCalled();
});

it('keeps each analysis preparation and overview draft separate while switching analyses and returning to the correct save action', async () => {
  render(<ResearchAnalyses {...defaults} />); await openAnalysis();
  fireEvent.change(question(), { target: { value: 'First unsent question.' } }); await enterPreparation();
  fireEvent.change(preparationDraft(), { target: { value: 'First preparation selection.' } }); await back();
  await openAnalysis(second); fireEvent.change(question(), { target: { value: 'Second unsent question.' } }); await enterPreparation();
  expect(preparation()).toHaveAttribute('data-analysis', second.id); expect(preparationDraft()).toHaveValue('');
  fireEvent.change(preparationDraft(), { target: { value: 'Second preparation selection.' } });
  fireEvent.click(within(preparation()).getByRole('button', { name: 'Return to save changes' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toHaveFocus());
  expect(question()).toHaveValue('Second unsent question.'); expect(within(overview()).getByRole('textbox', { name: 'Analysis name' })).toHaveValue(second.name);
  await openAnalysis(); expect(question()).toHaveValue('First unsent question.'); await enterPreparation();
  expect(preparationDraft()).toHaveValue('First preparation selection.'); await back(); await openAnalysis(second); await enterPreparation();
  expect(preparationDraft()).toHaveValue('Second preparation selection.'); expect(updateAnalysis).not.toHaveBeenCalled();
});

it('preserves existing notebook source and outside-result inspection context while opening a separate preparation panel', async () => {
  render(<ResearchAnalyses {...defaults} />); await openAnalysis();
  fireEvent.click(screen.getByRole('button', { name: 'Open documents' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Unsent notebook source' }), { target: { value: 'ncol(unsaved_object)' } });
  fireEvent.click(screen.getByRole('button', { name: 'Back from documents' }));
  fireEvent.click(screen.getByRole('button', { name: 'Outside results' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Chosen outside source' }), { target: { value: 'Earlier exact CSV revision and discussion.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Back from outside results' }));
  await enterPreparation(); fireEvent.change(preparationDraft(), { target: { value: 'Only a private sharing selection.' } }); await back();
  fireEvent.click(screen.getByRole('button', { name: 'Open documents' })); expect(screen.getByRole('textbox', { name: 'Unsent notebook source' })).toHaveValue('ncol(unsaved_object)');
  fireEvent.click(screen.getByRole('button', { name: 'Back from documents' })); fireEvent.click(screen.getByRole('button', { name: 'Outside results' }));
  expect(screen.getByRole('textbox', { name: 'Chosen outside source' })).toHaveValue('Earlier exact CSV revision and discussion.');
  expect(updateAnalysis).not.toHaveBeenCalled(); expect(createAnalysis).not.toHaveBeenCalled();
});

it.each(['user', 'project', 'connection'])('resets scoped preparation and overview drafts when %s changes', async scope => {
  const view = render(<ResearchAnalyses {...defaults} />); await openAnalysis(); fireEvent.change(question(), { target: { value: 'Old private overview.' } });
  await enterPreparation(); fireEvent.change(preparationDraft(), { target: { value: 'Old private preparation.' } });
  if (scope === 'connection') useExecutionTarget.mockReturnValue({ ...connection, identity: 'workspace-two', epoch: 2 });
  view.rerender(<ResearchAnalyses {...defaults} {...(scope === 'user' ? { userId: 2 } : scope === 'project' ? { projectId: 'project_two' } : {})} />);
  expect(screen.queryByDisplayValue('Old private preparation.')).not.toBeInTheDocument(); expect(screen.queryByDisplayValue('Old private overview.')).not.toBeInTheDocument();
  await openAnalysis(); expect(question()).toHaveValue(first.description); await enterPreparation(); expect(preparationDraft()).toHaveValue('');
  if (scope === 'user') expect(preparation()).toHaveAttribute('data-user', '2'); expect(updateAnalysis).not.toHaveBeenCalled();
});

it('passes current activity/connection fences without dropping drafts during a temporary disconnect or inactive page', async () => {
  const view = render(<ResearchAnalyses {...defaults} />); await openAnalysis(); await enterPreparation();
  fireEvent.change(preparationDraft(), { target: { value: 'Kept through transport interruption.' } });
  useExecutionTarget.mockReturnValue({ ...connection, blocked: true, epoch: 2 }); view.rerender(<ResearchAnalyses {...defaults} />);
  expect(preparation()).toHaveAttribute('data-available', 'false'); expect(preparationDraft()).toBeDisabled();
  useExecutionTarget.mockReturnValue({ ...connection, epoch: 3 }); view.rerender(<ResearchAnalyses {...defaults} isActive={false} />);
  expect(preparation()).toHaveAttribute('data-active', 'false'); expect(preparationDraft()).toHaveValue('Kept through transport interruption.');
  view.rerender(<ResearchAnalyses {...defaults} />); expect(preparationDraft()).toBeEnabled(); expect(preparationDraft()).toHaveValue('Kept through transport interruption.');
  expect(updateAnalysis).not.toHaveBeenCalled();
});

it('offers current readers saved preparations without making the analysis or prepared selection writable', async () => {
  render(<ResearchAnalyses {...defaults} role="viewer" />); await openAnalysis();
  expect(screen.queryByRole('button', { name: 'Prepare sharing', exact: true })).not.toBeInTheDocument(); await enterPreparation('Saved preparations');
  expect(preparation()).toHaveAttribute('data-writable', 'false'); expect(preparationDraft()).toBeDisabled(); await back();
  expect(question()).toHaveAttribute('readonly'); expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
});

it('returns natural phone navigation focus to preparation entry and save without silently committing the overview draft', async () => {
  vi.stubGlobal('innerWidth', 390); render(<ResearchAnalyses {...defaults} />); await openAnalysis();
  fireEvent.change(question(), { target: { value: 'Phone overview draft.' } }); await enterPreparation(); await back();
  expect(question()).toHaveValue('Phone overview draft.'); await enterPreparation();
  fireEvent.click(within(preparation()).getByRole('button', { name: 'Return to save changes' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toHaveFocus());
  expect(question()).toHaveValue('Phone overview draft.'); expect(updateAnalysis).not.toHaveBeenCalled();
});
