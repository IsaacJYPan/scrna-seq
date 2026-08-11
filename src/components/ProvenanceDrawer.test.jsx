import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ProvenanceDrawer from './ProvenanceDrawer';

describe('ProvenanceDrawer', () => {
  it('shows a safe research record without exposing source code or runtime details', () => {
    const { container } = render(
      <ProvenanceDrawer
        provId="prov_internal_1"
        onClose={vi.fn()}
        chain={[{
          id: 'prov_internal_1',
          operation: 'normalize_data',
          timestamp: '2026-08-10T00:00:00.000Z',
          language: 'R',
          languageVersion: '4.5.3',
          packages: ['Seurat'],
          script: 'file.copy("/private/vault/checkpoint.rds", output_dir)',
        }]}
      />
    );

    expect(screen.getByText('Normalize Data')).toBeInTheDocument();
    expect(screen.getByText(/Technical implementation details and source text are not shown here/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy preview/i })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/prov_internal_1|checkpoint\.rds|private\/vault|Seurat|4\.5\.3/i);
  });
});
