import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import PipelineCatalog from './PipelineCatalog';
import {
  getDefaultPipelineManifest,
  validatePipelineManifest,
} from '../pipelines/pipelineRegistry';

it('searches descriptions and previews another pipeline before activation', () => {
  const defaultManifest = getDefaultPipelineManifest();
  const custom = validatePipelineManifest({
    schemaVersion: 1,
    id: 'inspect-data',
    name: 'Inspect data',
    description: 'Review a new dataset',
    tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject' }],
  });
  const onSelect = vi.fn();
  render(
    <PipelineCatalog
      selectedId={defaultManifest.id}
      onSelect={onSelect}
      definitions={[
        {
          id: defaultManifest.id,
          name: defaultManifest.name,
          builtin: true,
          manifest: defaultManifest,
        },
        { id: 'pipe_inspect', name: custom.name, manifest: custom },
      ]}
    />
  );
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'new dataset' } });
  expect(
    screen.queryByRole('button', { name: /Standard scRNA-seq workflow/ })
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Inspect data/ }));
  expect(screen.getByRole('heading', { name: 'Inspect data' })).toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use pipeline' }));
  expect(onSelect).toHaveBeenCalledWith('pipe_inspect');
});
