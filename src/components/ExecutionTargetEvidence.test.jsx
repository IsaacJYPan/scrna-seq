import React from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import ExecutionTargetEvidence from './ExecutionTargetEvidence';

it('keeps a legacy broker identity separate from a retained installation identity', () => {
  render(<ExecutionTargetEvidence target={{ kind:'service',id:'private-r-kernel',generation:'a'.repeat(64) }}/>);
  expect(screen.getByText('Execution server').nextElementSibling).toHaveTextContent('Not retained');
  expect(screen.queryByText('Analysis server · private-r-kernel')).not.toBeInTheDocument();
});
