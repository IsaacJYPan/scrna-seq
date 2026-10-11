import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import DemoRouter from './DemoRouter';
import { readDemoPolicy } from './demoApi';

vi.mock('./demoApi', () => ({ readDemoPolicy: vi.fn() }));
vi.mock('../App', () => ({ default: () => <div>Full private workbench</div> }));
vi.mock('./DemoExperience', () => ({ default: () => <div>Automatic guided demo</div>,
  DemoLoading: ({ error, onRetry }) => <div>{error && <><p role="alert">{error}</p><button onClick={onRetry}>Try again</button></>}</div> }));
beforeEach(() => vi.clearAllMocks());

it('opens the guided experience for a demo deployment', async () => {
  readDemoPolicy.mockResolvedValue({ demoMode: true });
  render(<DemoRouter />);
  expect(await screen.findByText('Automatic guided demo')).toBeVisible();
  expect(screen.queryByText('Full private workbench')).not.toBeInTheDocument();
});
it('retains the full application for private deployments', async () => {
  readDemoPolicy.mockResolvedValue({ demoMode: false });
  render(<DemoRouter />);
  expect(await screen.findByText('Full private workbench')).toBeVisible();
});
it('retains the fixture workbench for a synthetic demo deployment', async () => {
  readDemoPolicy.mockResolvedValue({ demoMode: true, guidedDemoEnabled: false });
  render(<DemoRouter />);
  expect(await screen.findByText('Full private workbench')).toBeVisible();
});
it('retries a failed policy check without showing an unrelated login screen', async () => {
  readDemoPolicy.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ demoMode: true });
  render(<DemoRouter />);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not connect');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Automatic guided demo')).toBeVisible();
});
