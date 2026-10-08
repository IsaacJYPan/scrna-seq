import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WorkflowLibrary from './WorkflowLibrary';
import { serializeWorkflow } from '../../shared/workflowPackage.mjs';
import { workflowRequest } from '../pipelines/workflowApi';
import { downloadPipeline } from '../pipelines/pipelineFiles';
import tissueExample from '../../examples/analysis-model/tissue-image-inspection.json';

vi.mock('../pipelines/workflowApi', () => ({ workflowRequest: vi.fn() }));
vi.mock('../pipelines/pipelineFiles', async importOriginal => ({ ...(await importOriginal()), downloadPipeline: vi.fn() }));
const workflow = {
  format: 'traceomics-workflow', schemaVersion: 1, id: 'summary', name: 'Summary', version: '1.0.0', description: 'Count cells.',
  runtime: { language: 'r', profileId: 'test-profile' }, files: { 'summary.R': 'write_output("summary", list(cells = ncol(inputs$analysis)))' },
  steps: [{ id: 'summary', label: 'Summary', entry: 'summary.R', inputs: { analysis: { from: 'input.analysis', type: 'rds' } }, parameters: [], outputs: { summary: { type: 'metrics', label: 'Cell count' } } }],
  tabs: [{ id: 'summary', label: 'Summary', step: 'summary', plots: [] }],
};
const storageKey = 'traceomics:workflows:workflow@example.test';
const props = { userEmail: 'workflow@example.test', projectId: 'proj_one', selectedObject: { id: 'ao_one' }, enabled: true, onOpen: vi.fn() };
beforeEach(() => { localStorage.removeItem(storageKey); vi.clearAllMocks(); });
afterEach(() => localStorage.removeItem(storageKey));

it('reviews and installs a workflow without contacting the execution server', async () => {
  render(<WorkflowLibrary {...props} />);
  fireEvent.change(screen.getByLabelText('Workflow package file'), { target: { files: [new File([serializeWorkflow(workflow)], 'workflow.json')] } });
  fireEvent.click(await screen.findByRole('button', { name: 'Install Summary' }));
  expect(JSON.parse(localStorage.getItem(storageKey))).toEqual([serializeWorkflow(workflow)]);
  expect(workflowRequest).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Open Summary' })).toBeEnabled();
});

it('ignores an in-flight open response after the selected analysis changes', async () => {
  localStorage.setItem(storageKey, JSON.stringify([serializeWorkflow(workflow)]));
  let finish;
  workflowRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<WorkflowLibrary {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open Summary' }));
  view.rerender(<WorkflowLibrary {...props} selectedObject={{ id: 'ao_two' }} />);
  expect(workflowRequest.mock.calls[0][4].aborted).toBe(true);
  finish({ id: 'old_workflow' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open Summary' })).toBeEnabled());
  expect(props.onOpen).not.toHaveBeenCalled();
});

it('requires saved input and execution access before opening', () => {
  localStorage.setItem(storageKey, JSON.stringify([serializeWorkflow(workflow)]));
  const view = render(<WorkflowLibrary {...props} unsavedLiveChanges />);
  expect(screen.getByRole('button', { name: 'Open Summary' })).toBeDisabled();
  view.rerender(<WorkflowLibrary {...props} enabled={false} />);
  expect(screen.getByRole('button', { name: 'Open Summary' })).toBeDisabled();
  expect(workflowRequest).not.toHaveBeenCalled();
});

it('reviews, installs, reopens and exports a valid v2 recipe without dispatching it', async () => {
  const recipe = tissueExample.recipe;
  const view = render(<WorkflowLibrary {...props} runtimeProfileId="test-profile" />);
  fireEvent.change(screen.getByLabelText('Workflow package file'), { target: { files: [new File([serializeWorkflow(recipe)], 'tissue.pipeline.json')] } });
  expect(await screen.findByText('Valid recipe · execution unavailable')).toBeInTheDocument();
  expect(screen.getByText('No installed executor supports workflow schema 2.')).toBeInTheDocument();
  expect(screen.getByText('No human operation executor is installed.')).toBeInTheDocument();
  expect(screen.getByText('Inputs: image')).toBeInTheDocument();
  expect(screen.getByText('Operations: Inspect tissue preview (tool), Record inspected region (human)')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Install Tissue inspection' }));
  expect(screen.getByRole('button', { name: 'Open Tissue inspection' })).toBeDisabled();
  expect(JSON.parse(localStorage.getItem(storageKey))).toEqual([serializeWorkflow(recipe)]);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  expect(downloadPipeline).toHaveBeenCalledWith(recipe, 'lab.tissue-inspection-1.0.0.pipeline.json');
  view.unmount();
  render(<WorkflowLibrary {...props} />);
  expect(screen.getByRole('button', { name: 'Open Tissue inspection' })).toBeDisabled();
  expect(workflowRequest).not.toHaveBeenCalled();
});

it('keeps published recipe contents immutable during a conflicting import', async () => {
  const recipe = tissueExample.recipe;
  localStorage.setItem(storageKey, JSON.stringify([serializeWorkflow(recipe)]));
  render(<WorkflowLibrary {...props} />);
  const changed = { ...recipe, name: 'Changed tissue inspection' };
  fireEvent.change(screen.getByLabelText('Workflow package file'), { target: { files: [new File([serializeWorkflow(changed)], 'changed.json')] } });
  fireEvent.click(await screen.findByRole('button', { name: 'Install Changed tissue inspection' }));
  expect(screen.getByRole('alert')).toHaveTextContent('This version is installed with different contents. Use a new version number.');
  expect(JSON.parse(localStorage.getItem(storageKey))).toEqual([serializeWorkflow(recipe)]);
});

it('rejects malformed or oversized new recipes before installation', async () => {
  render(<WorkflowLibrary {...props} />);
  const recipe = JSON.parse(JSON.stringify(tissueExample.recipe));
  recipe.steps[1].bindings.image.port = 'missing';
  fireEvent.change(screen.getByLabelText('Workflow package file'), { target: { files: [new File([serializeWorkflow(recipe)], 'invalid.json')] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('root input missing does not exist');
  expect(screen.queryByRole('button', { name: 'Install Tissue inspection' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Workflow package file'), { target: { files: [new File(['x'.repeat(512 * 1024 + 1)], 'large.json')] } });
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('exceeds 512 KiB'));
  expect(workflowRequest).not.toHaveBeenCalled();
});

it('validates persisted recipes and removes an installed v2 version', () => {
  const recipe = tissueExample.recipe;
  localStorage.setItem(storageKey, JSON.stringify([serializeWorkflow(recipe)]));
  const view = render(<WorkflowLibrary {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(screen.queryByRole('button', { name: 'Open Tissue inspection' })).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(storageKey))).toEqual([]);
  view.unmount();
  localStorage.setItem(storageKey, JSON.stringify([serializeWorkflow({ ...recipe, schemaVersion: 8 })]));
  render(<WorkflowLibrary {...props} />);
  expect(screen.queryByRole('button', { name: 'Open Tissue inspection' })).not.toBeInTheDocument();
});

it('still opens an installed v1 workflow with its original package shape', async () => {
  localStorage.setItem(storageKey, JSON.stringify([serializeWorkflow(workflow)]));
  workflowRequest.mockResolvedValueOnce({ id: 'working-instance', package: workflow });
  render(<WorkflowLibrary {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open Summary' }));
  await waitFor(() => expect(props.onOpen).toHaveBeenCalledWith({ id: 'working-instance', package: workflow }));
  expect(workflowRequest).toHaveBeenCalledWith('proj_one', 'open', 'POST', { source: serializeWorkflow(workflow), analysisObjectId: 'ao_one' }, expect.any(AbortSignal));
});
