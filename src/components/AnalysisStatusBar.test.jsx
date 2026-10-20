import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AnalysisStatusBar from './AnalysisStatusBar';

const base = {
  datasetInfo: { id: 'analysis_1', name: 'PBMC', liveState: 'attached' },
  unsavedLiveChanges: false, checkpointSaveState: { phase: 'idle', message: '' },
  checkpointSaveBusy: false,
};

describe('Analysis status', () => {
  it('keeps the status and save control mounted when live changes arrive', () => {
    const onSave = vi.fn();
    const view = render(<AnalysisStatusBar {...base} onSave={onSave} />);
    const slot = screen.getByRole('region', { name: 'Analysis status' });
    const save = screen.getByRole('button', { name: 'Save current analysis' });
    expect(save).toBeDisabled();
    view.rerender(<AnalysisStatusBar {...base} unsavedLiveChanges onSave={onSave} />);
    expect(screen.getByRole('region', { name: 'Analysis status' })).toBe(slot);
    expect(screen.getByRole('button', { name: 'Save current analysis' })).toBe(save);
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved live changes.');
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('Status details'));
    expect(screen.getByText(/Closing this window/)).toBeVisible();
    expect(screen.getByText(/Queued analyses use the saved version/)).toBeVisible();
  });

  it('prevents a second save while confirmation is pending and offers recorded history', () => {
    const onSave = vi.fn(), onOpenHistory = vi.fn();
    render(<AnalysisStatusBar {...base} unsavedLiveChanges checkpointSaveBusy
      checkpointSaveState={{ phase: 'pending', message: 'Save was accepted. Confirmation is still pending.' }}
      onSave={onSave} onOpenHistory={onOpenHistory} />);
    const save = screen.getByRole('button', { name: 'Save current analysis' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Status details'));
    expect(screen.getByText('Save was accepted. Confirmation is still pending.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Review saved versions' }));
    expect(onOpenHistory).toHaveBeenCalledOnce();
    expect(screen.getByText('Status details').closest('details')).not.toHaveAttribute('open');
  });

  it('offers opening a durable saved version without suggesting it is live or editable', () => {
    const onOpenHistory = vi.fn();
    render(<AnalysisStatusBar {...base} datasetInfo={{ ...base.datasetInfo, liveState: 'saved' }} onOpenHistory={onOpenHistory} />);
    expect(screen.getByRole('status')).toHaveTextContent('Saved object selected');
    expect(screen.queryByRole('button', { name: 'Save current analysis' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open saved analysis from Runs & Results' }));
    expect(onOpenHistory).toHaveBeenCalledOnce();
  });

  it('recovers an already saved version when opening failed, without encouraging duplicate saves', () => {
    const onSave = vi.fn(), onOpenHistory = vi.fn();
    render(<AnalysisStatusBar {...base} unsavedLiveChanges onSave={onSave} onOpenHistory={onOpenHistory}
      checkpointSaveState={{ phase: 'error', durableSaved: true, message: 'Saved successfully, but opening failed.' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Saved; opening failed');
    expect(screen.queryByRole('button', { name: 'Save current analysis' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open saved analysis from Runs & Results' }));
    expect(onOpenHistory).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });
});
