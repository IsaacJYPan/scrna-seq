import { useEffect, useSyncExternalStore } from 'react';
import useExecutionTarget from '../runtime/useExecutionTarget';
import {
  ensureSubmissionRecovery, getSubmissionRecoverySnapshot, reconcileSubmissions, subscribeSubmissionRecovery,
} from './submissionRecovery';

export default function useSubmissionRecovery(userId, { initialize = false } = {}) {
  const connection = useExecutionTarget();
  const snapshot = useSyncExternalStore(subscribeSubmissionRecovery, getSubmissionRecoverySnapshot, getSubmissionRecoverySnapshot);
  useEffect(() => {
    if (!initialize || !userId || connection.blocked) return undefined;
    const controller = new AbortController();
    ensureSubmissionRecovery({ userId, force: true, signal: controller.signal })
      .then(() => { if (!controller.signal.aborted) return reconcileSubmissions({ signal: controller.signal }); })
      .catch(() => { /* Keep identifiers during an outage; mutation admission checks identity separately. */ });
    return () => controller.abort();
  }, [initialize, userId, connection.identity, connection.epoch, connection.blocked]);
  const visible = Boolean(snapshot.scope && Number.isSafeInteger(userId) && snapshot.scope.userId === userId && snapshot.connectionIdentity === connection.identity);
  return { ...snapshot, ready: visible, records: visible ? snapshot.records : [], selection: visible ? snapshot.selection : null,
    error: visible ? snapshot.error : '', connection };
}
