import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WorkflowLibrary from './WorkflowLibrary';
import { serializeWorkflow } from '../../shared/workflowPackage.mjs';
import { workflowRequest } from '../pipelines/workflowApi';

vi.mock('../pipelines/workflowApi', () => ({ workflowRequest: vi.fn() }));
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
