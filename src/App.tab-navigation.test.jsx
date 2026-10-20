import React, { useEffect, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TabContent } from './App';

it('preserves a visited analysis tab, but defers hidden probes for a different analysis until it opens', () => {
  const probe = vi.fn();
  function Analysis({ objectId }) {
    const [draft, setDraft] = useState('');
    useEffect(() => { probe(objectId); }, [objectId]);
    return <input aria-label="Review draft" value={draft} onChange={event => setDraft(event.target.value)} />;
  }
  const view = (activeTab, objectId) => <TabContent id="qc" activeTab={activeTab} contextKey={objectId}>
    <Analysis key={objectId} objectId={objectId} />
  </TabContent>;
  const rendered = render(view('qc', 'analysis-a'));
  fireEvent.change(screen.getByLabelText('Review draft'), { target: { value: 'keep this threshold draft' } });
  rendered.rerender(view('umap', 'analysis-a'));
  rendered.rerender(view('qc', 'analysis-a'));
  expect(screen.getByLabelText('Review draft')).toHaveValue('keep this threshold draft');
  expect(probe).toHaveBeenCalledTimes(1);
  rendered.rerender(view('workspace', 'analysis-b'));
  expect(screen.queryByLabelText('Review draft')).not.toBeInTheDocument();
  expect(probe).toHaveBeenCalledTimes(1);
  rendered.rerender(view('qc', 'analysis-b'));
  expect(screen.getByLabelText('Review draft')).toHaveValue('');
  expect(probe).toHaveBeenLastCalledWith('analysis-b');
  expect(probe).toHaveBeenCalledTimes(2);
});
