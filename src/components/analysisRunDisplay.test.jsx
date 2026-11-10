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
  researcherRunNote,
} from './analysisRunDisplay';

describe('analysis run display helpers', () => {
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
    expect(researcherRunNote({ message: 'Claimed by worker' })).toBe('Compute started.');
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
    const logs = Array.from({ length: 120 }, (_, index) => ({ level: 'info', ts: null, message: `claimed /srv/vault/${index}` }));
    const { container } = render(<JobLogs logs={logs} />);
    expect(screen.getAllByText('Compute started.')).toHaveLength(100);
    expect(container.textContent).not.toMatch(/vault/);
  });

  it('shows an empty notice before any run notes exist', () => {
    render(<JobLogs logs={null} />);
    expect(screen.getByText('No run notes yet')).toBeInTheDocument();
  });
});
