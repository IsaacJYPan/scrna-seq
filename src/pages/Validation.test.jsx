import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Validation from './Validation';

const datasetInfo = { id: 'ao_validation', name: 'PBMC 3k' };
const metrics = { cell_count: 2700, feature_count: 13714, pipeline_steps: 6 };

describe('Validation feedback', () => {
  it('retains previous measurements on failure and replaces them only after a successful retry', async () => {
    let finishRetry;
    const callApi = vi.fn()
      .mockResolvedValueOnce({ result: metrics })
      .mockResolvedValueOnce({ error: 'R service is busy' })
      .mockImplementationOnce(() => new Promise(resolve => { finishRetry = resolve; }));
    render(<Validation datasetInfo={datasetInfo} callApi={callApi} />);

    fireEvent.click(screen.getByRole('button', { name: 'Run Validation' }));
    await screen.findByRole('button', { name: 'Refresh Metrics' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Metrics' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Analysis compute is busy. Wait a moment and try again.');
    expect(alert).toHaveTextContent('Showing measurements from the last successful validation. This refresh did not update them.');
    expect(screen.getAllByText('2,700')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Retry validation' }));
    expect(screen.getByRole('button', { name: 'Refreshing Metrics…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Previously validated values remain visible below.');
    expect(screen.getAllByText('2,700')).toHaveLength(2);
    expect(callApi).toHaveBeenCalledTimes(3);
    expect(callApi).toHaveBeenLastCalledWith('/validate', {}, { operation: 'validation', useCache: false });

    await act(async () => { finishRetry({ result: { ...metrics, cell_count: 2800 } }); });
    expect(screen.getAllByText('2,800')).toHaveLength(2);
    expect(screen.queryByText('2,700')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh Metrics' })).toBeEnabled();
  });

  it.each([null, {}, { error: 'Internal server error at C:\\private\\analysis.rds' }])(
    'shows recoverable, sanitized feedback when validation returns %j', async response => {
      const callApi = vi.fn().mockResolvedValue(response);
      render(<Validation datasetInfo={datasetInfo} callApi={callApi} />);
      fireEvent.click(screen.getByRole('button', { name: 'Run Validation' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Validation could not be completed. Try again.');
      expect(alert).not.toHaveTextContent('last successful validation');
      expect(alert).not.toHaveTextContent('private');
      expect(screen.getByRole('button', { name: 'Run Validation' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Retry validation' })).toBeEnabled();
    }
  );

  it('allows retry after a rejected request without discarding previous measurements', async () => {
    const callApi = vi.fn()
      .mockResolvedValueOnce({ result: metrics })
      .mockRejectedValueOnce(new Error('NetworkError'));
    render(<Validation datasetInfo={datasetInfo} callApi={callApi} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run Validation' }));
    await screen.findByRole('button', { name: 'Refresh Metrics' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Metrics' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Validation could not be completed. Try again.');
    expect(screen.getAllByText('2,700')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Retry validation' })).toBeEnabled();
  });

  it('keeps validation unavailable without a selected dataset', () => {
    const callApi = vi.fn();
    render(<Validation datasetInfo={null} callApi={callApi} />);
    expect(screen.getByText('Validation Offline')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(callApi).not.toHaveBeenCalled();
  });
});
