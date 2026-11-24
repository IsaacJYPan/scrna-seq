import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AiAuthorshipBadge, { aiAuthorshipDetail, aiAuthorshipLabel } from './AiAuthorshipBadge';
import AnalysisStatusBar from './AnalysisStatusBar';
import { mapBackendAnalysisObject } from '../backendWorkspaceModel';

const authorship = { kind: 'ai_written_code', agentName: 'Analyst agent', reviewState: 'draft', reason: 'No verified method covers this.' };

describe('AiAuthorshipBadge', () => {
  it('labels AI-written results by review state and explains them', () => {
    expect(aiAuthorshipLabel(authorship)).toBe('AI-written code · Needs review');
    expect(aiAuthorshipLabel({ ...authorship, reviewState: 'promoted' })).toBe('AI-written code · Reviewed and promoted');
    expect(aiAuthorshipLabel({ ...authorship, reviewState: 'discarded' })).toBe('AI-written code · Discarded by reviewer');
    expect(aiAuthorshipDetail(authorship)).toContain('"Analyst agent"');
    expect(aiAuthorshipDetail(authorship)).toContain('No verified method covers this.');
    expect(aiAuthorshipLabel(null)).toBeNull();
  });

  it('renders nothing for ordinary results', () => {
    const { container } = render(<AiAuthorshipBadge authorship={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the flag on the mapped object and shows it in the status bar on every page', () => {
    const object = mapBackendAnalysisObject({ id: 'ao_1', projectId: 'proj_1', displayName: 'Agent run 1', aiAuthorship: authorship });
    expect(object.aiAuthorship).toEqual(authorship);
    expect(mapBackendAnalysisObject({ id: 'ao_2', projectId: 'proj_1', displayName: 'Plain' }).aiAuthorship).toBeNull();
    render(<AnalysisStatusBar datasetInfo={object} unsavedLiveChanges={false} checkpointSaveState={{ phase: 'idle' }} onSave={() => {}} onOpenHistory={() => {}} />);
    expect(screen.getByTestId('ai-authorship-badge')).toHaveTextContent('Needs review');
    expect(screen.getByTestId('ai-authorship-badge')).toHaveAttribute('title', expect.stringContaining('not from a verified workflow'));
  });
});
