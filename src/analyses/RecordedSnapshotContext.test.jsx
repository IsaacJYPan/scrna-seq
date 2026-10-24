import React from 'react';
import { createHash } from 'node:crypto';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import RecordedSnapshotContext from './RecordedSnapshotContext';
import { projectAnalysisSnapshotWorkflowContext, canonicalAnalysisSnapshotWorkflowContextBinding,
  normalizeAnalysisSnapshotWorkflowContextEvidence } from '../../shared/analysisSnapshotWorkflowContext.mjs';
import { snapshotScope } from './snapshotPreparationTestFixtures';

const sha = value => createHash('sha256').update(value).digest('hex');
const capture = { kind: 'workflow-snapshot', snapshotId: 'wfs_' + '4'.repeat(24), sha256: 'a'.repeat(64) };
const environment = { id: 'renv_' + 'b'.repeat(64), manifestSha256: 'b'.repeat(64), profileId: 'expert-r-seurat-v1',
  rVersion: '4.4.2', bioconductor: '3.20', imageDigest: 'sha256:' + 'c'.repeat(64), imageId: 'sha256:' + 'd'.repeat(64), snapshotScope: 'container-userspace' };
function origin({ selected = {}, offered = {} } = {}) {
  const context = projectAnalysisSnapshotWorkflowContext({ snapshotReference: capture, stepId: 'measure', port: 'counts',
    offer: { method: { id: 'measure-cells', name: 'Recorded cell method', version: '1.2.0', digest: 'e'.repeat(64), stepLabel: 'Summarise cells', outputLabel: 'Condition counts' },
      parameters: [{ key: 'filter', type: 'boolean', label: 'Apply filtering', value: false }, { key: 'minimum', type: 'integer', label: 'Minimum count', value: 0 },
        { key: 'ratio', type: 'number', label: 'Selected ratio', value: 0.125 }, { key: 'mode', type: 'choice', label: 'Summary mode', value: 'per-condition' }],
      seed: 0, environment, ...offered },
    selection: { method: true, parameterKeys: ['minimum', 'filter', 'ratio', 'mode'], seed: true, environment: true, ...selected } });
  return { kind: 'captured-workflow-output', context, contextSha256: sha(canonicalAnalysisSnapshotWorkflowContextBinding({
    serviceId: snapshotScope.serviceId, projectId: snapshotScope.projectId, analysisId: snapshotScope.analysisId,
    ownerUserId: snapshotScope.userId, analysisVersion: 2, context })), contextEvidence: normalizeAnalysisSnapshotWorkflowContextEvidence({
    capture: 'fingerprint-checked', environment: context.environment === null ? 'not-included' : 'manifest-checked' }, context) };
}
const open = () => { const node = screen.getByLabelText('Recorded workflow context'); fireEvent.click(within(node).getByText('Recorded in this workflow capture')); node.open = true; return within(node); };
afterEach(() => vi.restoreAllMocks());

it('keeps exact recorded context compact until opened and preserves selected false, zero, fractions, choices and seed zero', () => {
  render(<RecordedSnapshotContext origin={origin()} />);
  expect(screen.getByText('Recorded in this workflow capture')).toBeVisible(); expect(screen.getByLabelText('Recorded workflow context')).not.toHaveAttribute('open');
  const context = open(), settings = context.getByRole('region', { name: 'Recorded settings' });
  expect(within(settings).getAllByRole('term').map(item => item.textContent)).toEqual(['Minimum count', 'Apply filtering', 'Selected ratio', 'Summary mode']);
  expect(within(settings).getAllByRole('definition').map(item => item.textContent)).toEqual(['0', 'false', '0.125', 'per-condition']);
  expect(context.getByText('Recorded random seed:')).toHaveTextContent('Recorded random seed: 0');
  expect(context.getByText('Recorded cell method · 1.2.0')).toBeVisible(); expect(context.getByText('Summarise cells')).toBeVisible();
  expect(context.getByText('Condition counts')).toBeVisible();
});

it('distinguishes recorded environment evidence and source fingerprints from current runtime availability or producing-code claims', () => {
  const value = origin(); render(<RecordedSnapshotContext origin={value} />); const context = open();
  expect(context.getByText('Recorded environment reference checked when prepared; current runtime availability not checked.')).toBeVisible();
  expect(context.getByText('This selected context is separate from the supplied caption. It does not establish the code or runtime that originally produced the result.')).toBeVisible();
  expect(context.getByText('4.4.2')).toBeVisible(); expect(context.getByText('3.20')).toBeVisible();
  const exact = context.getByText('Exact capture identities').closest('details'); expect(exact).not.toHaveAttribute('open'); exact.open = true;
  expect(within(exact).getByText(capture.snapshotId)).toBeVisible(); expect(within(exact).getByText(value.contextSha256)).toBeVisible();
  expect(within(exact).getByText(environment.manifestSha256)).toBeVisible(); expect(within(exact).getByText(environment.imageId)).toBeVisible();
  expect(context.queryByRole('button', { name: /Run|Restore|Open|Download|Inspect/ })).not.toBeInTheDocument();
});

it('does not substitute omitted context from method defaults or a newer environment', () => {
  render(<RecordedSnapshotContext origin={origin({ selected: { method: false, parameterKeys: [], seed: false, environment: false } })} />); const context = open();
  expect(context.getByText('No method, settings, seed or environment reference was included.')).toBeVisible();
  expect(context.queryByRole('region', { name: 'Recorded method' })).not.toBeInTheDocument();
  expect(context.queryByRole('region', { name: 'Recorded settings' })).not.toBeInTheDocument();
  expect(context.queryByRole('region', { name: 'Recorded environment reference' })).not.toBeInTheDocument();
  expect(context.queryByText(/Recorded random seed/)).not.toBeInTheDocument(); expect(context.queryByText(/current runtime availability/)).not.toBeInTheDocument();
});

it('renders recorded labels as inert text and performs no fetch, runtime or browser-storage work when opened', () => {
  const network = vi.spyOn(globalThis, 'fetch'), storage = vi.spyOn(Storage.prototype, 'setItem');
  const value = origin({ offered: { method: { id: 'measure-cells', name: '<script>run()</script>', version: '1.2.0', digest: 'e'.repeat(64),
    stepLabel: '<img src=x onerror=run()>', outputLabel: 'Literal output' } } });
  render(<RecordedSnapshotContext origin={value} />); const context = open();
  expect(context.getByText('<script>run()</script> · 1.2.0')).toBeVisible(); expect(context.getByText('<img src=x onerror=run()>')).toBeVisible();
  expect(document.querySelector('script,img,iframe')).toBeNull(); expect(network).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
});

it.each(['unknown schema', 'producing relation', 'unverified capture', 'wrong environment evidence'])('shows no recorded claims for %s', invalid => {
  const value = origin();
  if (invalid === 'unknown schema') value.context.schema = 'traceomics.captured-workflow-context.v99';
  else if (invalid === 'producing relation') value.context.relation = 'produced-by';
  else if (invalid === 'unverified capture') value.contextEvidence.capture = 'not-checked';
  else value.contextEvidence.environment = 'not-included';
  render(<RecordedSnapshotContext origin={value} />);
  expect(screen.getByRole('alert')).toHaveTextContent('recorded workflow context could not be verified');
  expect(screen.queryByLabelText('Recorded workflow context')).not.toBeInTheDocument(); expect(screen.queryByText('Recorded cell method · 1.2.0')).not.toBeInTheDocument();
});

it.each([undefined, { kind: 'analysis-reference' }, { kind: 'typed-analysis-reference' }, { kind: 'unknown' }])('does not invent captured context for another result origin', value => {
  const view = render(<RecordedSnapshotContext origin={value} />); expect(view.container).toBeEmptyDOMElement();
});
