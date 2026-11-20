import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  EmptyNotice,
  JobLogs,
  StatusBadge,
  displayRunStatus,
  formatDate,
  parseErrorMessage,
  parseServerTime,
  researcherRunNote,
} from './analysisRunDisplay';

describe('analysis run display helpers', () => {
  it('reads the server canonical timestamp as UTC, not local time', () => {
    expect(parseServerTime('2026-11-20 02:44:14').toISOString()).toBe('2026-11-20T02:44:14.000Z');
    expect(parseServerTime('2026-11-20T02:44:14.000Z').toISOString()).toBe('2026-11-20T02:44:14.000Z');
    expect(parseServerTime('not a date')).toBeNull();
    expect(formatDate('2026-11-20 02:44:14')).toBe(new Date('2026-11-20T02:44:14Z').toLocaleString());
  });

  it('formats dates and keeps unparseable values visible', () => {
    expect(formatDate(null)).toBe('Unknown');
    expect(formatDate('not a date')).toBe('not a date');
    expect(formatDate('2026-01-02T03:04:05Z')).toBe(new Date('2026-01-02T03:04:05Z').toLocaleString());
  });

  it('labels run statuses with a page-specific fallback', () => {
    expect(displayRunStatus('queued')).toBe('Waiting for compute');
    expect(displayRunStatus('failed')).toBe('Needs attention');
    expect(displayRunStatus('mystery')).toBe('Unknown');
    expect(displayRunStatus(undefined, 'Preparing')).toBe('Preparing');
  });

  it('summarizes worker log entries without echoing their text', () => {
    expect(researcherRunNote({ level: 'error', message: 'Traceback at /vault/x' })).toBe('This analysis needs attention.');
    expect(researcherRunNote({ message: 'Job completed' })).toBe('Analysis finished.');
    expect(researcherRunNote({ message: 'Claimed by worker' })).toBe('Picked up by compute.');
    expect(researcherRunNote({ message: 'Handler started.' })).toBe('Compute started.');
    expect(researcherRunNote({ level: 'warn', message: 'slow' })).toBe('Analysis warning recorded.');
    expect(researcherRunNote(null)).toBe('Analysis update recorded.');
  });

  it('unpacks JSON API errors into public messages', () => {
    expect(parseErrorMessage(new Error(JSON.stringify({ error: 'Select a target group.' })))).toBe('Select a target group.');
    expect(parseErrorMessage(new Error('Rscript failed at /home/user/x'))).not.toMatch(/Rscript|\/home/);
  });

  it('renders badges with a safe default tone and empty notices', () => {
    render(<><StatusBadge tone="nope">queued</StatusBadge><EmptyNotice title="Nothing yet">Run first.</EmptyNotice></>);
    expect(screen.getByText('queued').className).toContain('text-textMuted');
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
    expect(screen.getByText('Run first.')).toBeInTheDocument();
  });

  it('lists run notes as bounded researcher summaries, never raw worker text', () => {
    const logs = Array.from({ length: 120 }, (_, index) => ({ level: 'info', ts: null, message: `started /srv/vault/${index}` }));
    const { container } = render(<JobLogs logs={logs} />);
    expect(screen.getAllByText('Compute started.')).toHaveLength(100);
    expect(container.textContent).not.toMatch(/vault/);
  });

  it('gives the worker claim and the handler start different notes', () => {
    render(<JobLogs logs={[
      { level: 'info', ts: null, message: 'Claimed by worker (type=enrichment.gsea.v1).' },
      { level: 'info', ts: null, message: 'Handler started.' },
      { level: 'info', ts: null, message: 'Handler completed.' },
    ]} />);
    expect(screen.getAllByText('Compute started.')).toHaveLength(1);
    expect(screen.getByText('Picked up by compute.')).toBeInTheDocument();
    expect(screen.getByText('Analysis finished.')).toBeInTheDocument();
  });

  it('shows an empty notice before any run notes exist', () => {
    render(<JobLogs logs={null} />);
    expect(screen.getByText('No run notes yet')).toBeInTheDocument();
  });
});
