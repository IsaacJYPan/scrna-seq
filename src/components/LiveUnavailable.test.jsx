import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import LiveUnavailable from './LiveUnavailable';

it('says the saved version is not open, not that a step is missing, and links to Runs & Results', () => {
  const onOpenHistory = vi.fn();
  render(<LiveUnavailable onOpenHistory={onOpenHistory} />);
  expect(screen.getByRole('heading', { name: 'Saved version not open' })).toBeInTheDocument();
  expect(screen.queryByText(/PCA Required/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Runs & Results' }));
  expect(onOpenHistory).toHaveBeenCalled();
});

it('shows progress while the saved version is being reopened', () => {
  render(<LiveUnavailable reopening onOpenHistory={vi.fn()} />);
  expect(screen.getByRole('heading', { name: 'Reopening your saved version' })).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
