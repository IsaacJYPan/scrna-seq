import { useSyncExternalStore } from 'react';
import { getExecutionTargetSnapshot, subscribeExecutionTarget } from './executionTarget';

export default function useExecutionTarget() {
  return useSyncExternalStore(subscribeExecutionTarget, getExecutionTargetSnapshot, getExecutionTargetSnapshot);
}
