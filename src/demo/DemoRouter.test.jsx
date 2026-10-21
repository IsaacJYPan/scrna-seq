import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import DemoRouter from './DemoRouter';
import { readDemoPolicy } from './demoApi';
import { preloadPlotlyRenderer } from '../components/Plot';

vi.mock('./demoApi', () => ({ readDemoPolicy: vi.fn() }));
vi.mock('../components/Plot', () => ({ preloadPlotlyRenderer: vi.fn(() => Promise.resolve()) }));
vi.mock('../App', () => ({ default: () => <div>Full private workbench</div> }));
vi.mock('./DemoExperience', () => ({ default: () => <div>Automatic guided demo</div> }));
beforeEach(() => vi.clearAllMocks());

it('opens the guided experience for a demo deployment', async () => {
  readDemoPolicy.mockResolvedValue({ demoMode: true });
  render(<DemoRouter />);
  expect(await screen.findByText('Automatic guided demo')).toBeVisible();
  expect(preloadPlotlyRenderer).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Full private workbench')).not.toBeInTheDocument();
});
it('retains the full application for private deployments', async () => {
  readDemoPolicy.mockResolvedValue({ demoMode: false });
  render(<DemoRouter />);
  expect(await screen.findByText('Full private workbench')).toBeVisible();
  expect(preloadPlotlyRenderer).not.toHaveBeenCalled();
});
it('retains the fixture workbench for a synthetic demo deployment', async () => {
  readDemoPolicy.mockResolvedValue({ demoMode: true, guidedDemoEnabled: false });
  render(<DemoRouter />);
  expect(await screen.findByText('Full private workbench')).toBeVisible();
  expect(preloadPlotlyRenderer).not.toHaveBeenCalled();
});
it('retries a failed policy check without showing an unrelated login screen', async () => {
  readDemoPolicy.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ demoMode: true });
  render(<DemoRouter />);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not connect');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Automatic guided demo')).toBeVisible();
});
