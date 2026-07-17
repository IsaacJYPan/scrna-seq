import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PipelineTemplatePreview from './PipelineTemplatePreview';
import { validatePipelineManifest } from '../pipelines/pipelineRegistry';

describe('PipelineTemplatePreview', () => {
  it('renders every allowlisted parameter type as a disabled preview and never creates executable markup', () => {
    const manifest = validatePipelineManifest({
      schemaVersion: 1,
      id: 'typed-preview',
      name: 'Typed Preview',
      tabs: [
        {
          id: 'qc',
          label: 'QC Controls',
          moduleKey: 'seuratQc',
          parameterSchema: [
            { key: 'enabled', label: 'Enabled', type: 'boolean', default: true },
            { key: 'threshold', label: 'Threshold', type: 'number', min: 0, max: 10, step: 0.5, default: 2.5 },
            { key: 'features', label: 'Features', type: 'integer', min: 1, max: 1000, default: 200 },
            {
              key: 'genes',
              label: '<img src=x onerror=alert(1)>',
              type: 'text',
              maxLength: 100,
              placeholder: 'MS4A1',
            },
          ],
          resultViews: [{ type: 'placeholder', title: '<script>alert(1)</script>' }],
        },
        {
          id: 'normalize',
          label: 'Normalization Controls',
          moduleKey: 'seuratNormalize',
          parameterSchema: [{
            key: 'method',
            label: 'Method',
            type: 'enum',
            options: ['LogNormalize', 'CLR'],
            default: 'CLR',
          }],
          resultViews: ['summaryMetrics'],
        },
        {
          id: 'deg',
          label: 'Durable Results',
          moduleKey: 'differentialExpression',
          resultArtifactTypes: ['deg_markers'],
          resultViews: [
            { type: 'artifactTable', title: 'Marker table', artifactType: 'deg_markers' },
            'jobLogs',
          ],
        },
      ],
    });

    const { container } = render(<PipelineTemplatePreview manifest={manifest} />);

    expect(screen.getByText(/read-only preview and never submit code or start a job/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeDisabled();
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
    expect(screen.getAllByRole('spinbutton').every(input => input.disabled)).toBe(true);
    expect(screen.getByRole('textbox', { name: '<img src=x onerror=alert(1)>' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Method' })).toHaveValue('CLR');
    expect(screen.getByRole('combobox', { name: 'Method' })).toBeDisabled();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(screen.getByText('Marker table')).toBeInTheDocument();
    expect(screen.getByText('Job logs')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows an explicit empty state when no interface templates are declared', () => {
    render(<PipelineTemplatePreview manifest={{ id: 'empty', tabs: [{
      id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject', parameterSchema: [], resultViews: [],
    }] }} />);

    expect(screen.getByText(/does not declare any parameter or result-view templates/i)).toBeInTheDocument();
  });
});
