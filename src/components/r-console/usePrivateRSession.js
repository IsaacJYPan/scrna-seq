import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as api from '../../executions/privateKernelApi';
import * as recovery from '../../executions/privateSubmissionRecovery';
import {
  getArtifactVersion,
  listArtifactVersions,
  previewArtifactVersion,
} from '../../artifacts/artifactApi';
import { readPrivateRArtifactPolicy } from '../../artifacts/privateRArtifactPolicy';
import useExecutionTarget from '../../runtime/useExecutionTarget';
import { TARGET_DISCONNECTED_MESSAGE } from '../../runtime/executionTarget';

const activeStatuses = ['starting', 'ready', 'running', 'unknown', 'stopping'];
const outputFormats = { object: 'org.r-project.rds', table: 'org.ietf.csv', figure: 'org.w3.png' };
export const journalLimit = 120;
export const terminalStatuses = ['stopped', 'dead', 'expired', 'failed'];
export const unresolvedSubmission = (record) =>
  !record.confirmed ||
  record.state !== 'accepted' ||
  (record.kind === 'execution' && !record.completionKnown) ||
  (['publication', 'restart'].includes(record.kind) &&
    !['completed', 'failed'].includes(record.status)) ||
  (record.kind === 'start' && ['starting', 'unknown'].includes(record.status));
const notAdmitted = (failure) =>
  ['PRIVATE_SUBMISSION_STORAGE_UNAVAILABLE', 'PRIVATE_SUBMISSION_RECOVERY_REQUIRED'].includes(
    failure?.code
  );

export default function usePrivateRSession({
  projectId,
  userId,
  workspaceId,
  deploymentPolicy,
  onResetDrafts,
}) {
  const connection = useExecutionTarget();
  const blocked = connection.blocked;
  const recovered = useSyncExternalStore(
    recovery.subscribePrivateRecovery,
    recovery.getPrivateRecoverySnapshot,
    recovery.getPrivateRecoverySnapshot
  );
  const retainedRequests =
    recovered.scope?.userId === Number(userId)
      ? recovered.records.filter(
          (record) =>
            record.projectId === projectId &&
            (!record.workspaceId || record.workspaceId === workspaceId)
        )
      : [];
  const recoveryBlocked =
    !recovered.scope ||
    recovered.scope.userId !== Number(userId) ||
    retainedRequests.some(unresolvedSubmission);
  const [forgetRequest, setForgetRequest] = useState(null);
  const [session, setSession] = useState(null);
  const [journal, setJournal] = useState([]);
  const [entry, setEntry] = useState(null);
  const [versions, setVersions] = useState([]);
  const [selectedInputs, setSelectedInputs] = useState([]);
  const [objectId, setObjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [runningCommand, setRunningCommand] = useState(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [controlNotice, setControlNotice] = useState('');
  const [restartReceipt, setRestartReceipt] = useState(null);
  const [previousEvidence, setPreviousEvidence] = useState(null);
  const [publicationForm, setPublicationForm] = useState({
    type: 'object',
    binding: '',
    name: '',
    previousVersionId: '',
  });
  const [figureSelection, setFigureSelection] = useState(null);
  const [publications, setPublications] = useState([]);
  const [savedPreview, setSavedPreview] = useState(null);
  const [publicationUncertain, setPublicationUncertain] = useState(false);
  const [saving, setSaving] = useState(false);
  const [inspection, setInspection] = useState(null);
  const [inspecting, setInspecting] = useState(false);
  const [journalCursor, setJournalCursor] = useState(null);
  const requestEpoch = useRef(0);
  const startRequest = useRef(null);
  const kernelEpoch = useRef(0);
  const pendingCommand = useRef(null);
  const restartRequest = useRef(null);
  const inspectionEpoch = useRef(0);
  const inspectionController = useRef(null);
  const inspectionTimer = useRef(null);
  const installation = useRef(null);
  const pendingPublication = useRef(null);
  const environment =
    deploymentPolicy.expertREnvironment || deploymentPolicy.expertRStatus?.runtime?.environment;
  const supported =
    deploymentPolicy.expertREnabled === true &&
    (deploymentPolicy.persistentKernel === true ||
      deploymentPolicy.expertRStatus?.runtime?.persistentKernel === true);
  const enabled = Boolean(
    projectId && userId && workspaceId && supported && !deploymentPolicy.demoMode
  );
  const publicationSupported =
    deploymentPolicy.persistentKernelPublications === true ||
    deploymentPolicy.expertRStatus?.runtime?.persistentKernelPublications === true;
  const interruptSupported =
    deploymentPolicy.persistentKernelInterrupt === true ||
    deploymentPolicy.expertRStatus?.runtime?.persistentKernelInterrupt === true;
  const artifactPolicy = readPrivateRArtifactPolicy(deploymentPolicy.expertRArtifactPolicy);
  const currentScope = useRef('');
  const scopeKey = `${projectId}:${userId}:${workspaceId}:${connection.identity}`;
  currentScope.current = scopeKey;
  const liveContext = useRef(null);
  liveContext.current = { scopeKey, epoch: connection.epoch, blocked, enabled };
  const currentSession = useRef(null);
  currentSession.current = session;
  const selectedEntry = useRef(null);
  selectedEntry.current = entry;
  const inspected = Boolean(
    inspection &&
      inspection.scopeKey === scopeKey &&
      inspection.epoch === connection.epoch &&
      !blocked &&
      inspection.kernelId === (session?.id || null) &&
      inspection.generation === (session?.generation || null)
  );
  const active = session && activeStatuses.includes(session.status);
  const resetDrafts = useCallback(() => {
    onResetDrafts();
    setObjectId('');
    setPublicationForm({ type: 'object', binding: '', name: '', previousVersionId: '' });
    startRequest.current = null;
  }, [onResetDrafts]);
  function clearPrivate() {
    kernelEpoch.current += 1;
    setInspection(null);
    setJournalCursor(null);
    setSaving(false);
    pendingCommand.current = null;
    pendingPublication.current = null;
    restartRequest.current = null;
    setForgetRequest(null);
    setBusy(false);
    setSession(null);
    setJournal([]);
    setEntry(null);
    setSelectedInputs([]);
    setVersions([]);
    setUncertain(false);
    setPublications([]);
    setSavedPreview(null);
    setFigureSelection(null);
    setPublicationUncertain(false);
    setControlBusy(false);
    setRunningCommand(null);
    setConfirmStop(false);
    setConfirmRestart(false);
    setControlNotice('');
    setRestartReceipt(null);
    setPreviousEvidence(null);
  }
  const confirmation = (kernel) => ({
    scopeKey,
    epoch: connection.epoch,
    kernelId: kernel?.id || null,
    generation: kernel?.generation || null,
  });
  async function saveRecoveredSelection(value, options) {
    if (!(await recovery.selectPrivateRecoveredSession(value, options)))
      throw Object.assign(
        new Error(
          'Your R session selection could not be saved. Check session status before continuing.'
        ),
        { code: 'PRIVATE_SUBMISSION_UNCONFIRMED' }
      );
  }
  async function runRequest(action, { publication = false, control = false } = {}) {
    if (blocked) {
      setError(TARGET_DISCONNECTED_MESSAGE);
      return undefined;
    }
    const epoch = requestEpoch.current;
    const generationEpoch = kernelEpoch.current;
    const scope = scopeKey;
    const setPending = control ? setControlBusy : setBusy;
    setPending(true);
    setError('');
    const targetEpoch = connection.epoch;
    const authority = recovery.getPrivateRecoverySnapshot();
    const currentRequest = () => {
      const latest = recovery.getPrivateRecoverySnapshot();
      return (
        epoch === requestEpoch.current &&
        generationEpoch === kernelEpoch.current &&
        scope === currentScope.current &&
        targetEpoch === liveContext.current.epoch &&
        !liveContext.current.blocked &&
        (!authority.scope ||
          (latest.scope &&
            latest.scope.userId === authority.scope.userId &&
            latest.scope.installationId === authority.scope.installationId &&
            latest.generation === authority.generation &&
            latest.accessGeneration === authority.accessGeneration))
      );
    };
    try {
      const result = await action();
      if (currentRequest()) return result;
    } catch (failure) {
      if (currentRequest()) {
        setError(failure.message);
        if ([401, 403, 404].includes(failure.status)) {
          clearPrivate();
          resetDrafts();
        }
        if (
          [
            'PRIVATE_KERNEL_TRANSPORT_UNKNOWN',
            'PRIVATE_KERNEL_RESPONSE_INVALID',
            'TARGET_EXECUTION_UNCONFIRMED',
            'PRIVATE_SUBMISSION_UNCONFIRMED',
            'PRIVATE_SUBMISSION_RECOVERY_REQUIRED',
            'PRIVATE_SUBMISSION_STORAGE_UNAVAILABLE',
            'PRIVATE_SUBMISSION_RECOVERY_CHANGED',
          ].includes(failure.code)
        ) {
          setInspection(null);
          setUncertain(true);
          if (publication) setPublicationUncertain(true);
        }
      }
    } finally {
      if (currentRequest()) setPending(false);
    }
  }
  async function refreshJournal(kernel) {
    return api.listPrivateRExecutions(projectId, kernel.id, { limit: 30 });
  }
  async function refresh({
    kernel: preferredKernel,
    detail: preferredDetail,
    requestId: preferredRequestId,
    intentRequestId,
  } = {}) {
    if (!enabled || blocked) return;
    inspectionController.current?.abort();
    clearTimeout(inspectionTimer.current);
    const controller = new AbortController();
    inspectionController.current = controller;
    const sequence = ++inspectionEpoch.current;
    const epoch = requestEpoch.current;
    const context = liveContext.current;
    let recoveryInspection = null;
    const currentInspection = () =>
      sequence === inspectionEpoch.current &&
      epoch === requestEpoch.current &&
      context.scopeKey === liveContext.current.scopeKey &&
      context.epoch === liveContext.current.epoch &&
      !liveContext.current.blocked &&
      liveContext.current.enabled;
    const valid = () => !controller.signal.aborted && currentInspection();
    const check = () => {
      if (!valid()) throw new DOMException('Session inspection changed.', 'AbortError');
      if (recoveryInspection) {
        const latest = recovery.getPrivateRecoverySnapshot();
        const a = recoveryInspection.selection;
        const b = latest.selection;
        const sameSelection =
          JSON.stringify(a) === JSON.stringify(b) ||
          (a?.requestId &&
            a.requestId === b?.requestId &&
            latest.records.some(
              (record) => record.kind === 'restart' && record.requestId === a.requestId
            ));
        if (
          !latest.scope ||
          latest.scope.userId !== recoveryInspection.scope.userId ||
          latest.scope.installationId !== recoveryInspection.scope.installationId ||
          latest.generation !== recoveryInspection.generation ||
          latest.accessGeneration !== recoveryInspection.accessGeneration ||
          latest.mutationGeneration !== recoveryInspection.mutationGeneration ||
          !sameSelection
        )
          throw Object.assign(
            new Error(
              'Private R request selection changed during inspection. Check session status again before continuing.'
            ),
            { code: 'PRIVATE_SUBMISSION_RECOVERY_CHANGED' }
          );
      }
    };
    setInspecting(true);
    setInspection(null);
    setError('');
    const timer = setTimeout(() => {
      if (currentInspection()) {
        controller.abort();
        setInspection(null);
        setInspecting(false);
        setUncertain(true);
        setError(
          'The private R session could not be confirmed within 30 seconds. Check session status again before running or saving. Previous results remain available.'
        );
      }
    }, 30000);
    inspectionTimer.current = timer;
    try {
      const identity = await api.getPrivateRIdentity(controller.signal);
      check();
      if (
        identity?.schema !== 'traceomics.installation.v1' ||
        !/^svc_[a-f0-9]{32}$/.test(identity.installationId) ||
        identity.userId !== Number(userId)
      )
        throw Object.assign(
          new Error(
            'Your signed-in account or server identity changed. Sign in again before opening private R.'
          ),
          { status: 401 }
        );
      const changed = installation.current && installation.current !== identity.installationId;
      installation.current = identity.installationId;
      if (changed) {
        clearPrivate();
        resetDrafts();
      }
      await recovery.ensurePrivateRecovery({ userId, force: true, signal: controller.signal });
      check();
      await recovery.reconcilePrivateSubmissions({
        projectId,
        workspaceId,
        signal: controller.signal,
      });
      check();
      const durable = recovery.getPrivateRecoverySnapshot();
      if (
        !durable.scope ||
        durable.scope.userId !== Number(userId) ||
        durable.scope.installationId !== identity.installationId
      )
        throw Object.assign(
          new Error(
            'Private R request recovery is unconfirmed. Inspect session status before continuing.'
          ),
          { code: 'PRIVATE_KERNEL_TRANSPORT_UNKNOWN' }
        );
      recoveryInspection = durable;
      let records = durable.records.filter(
        (record) =>
          record.projectId === projectId &&
          (!record.workspaceId || record.workspaceId === workspaceId)
      );
      const focusedRequest = records.find((record) => record.requestId === preferredRequestId);
      const retained =
        durable.selection?.projectId === projectId && durable.selection.workspaceId === workspaceId
          ? durable.selection
          : null;
      const ownsPreferred =
        !intentRequestId ||
        !retained ||
        (retained.requestId === intentRequestId &&
          (!preferredDetail || retained.executionId === preferredDetail.id));
      const pendingStart = records.find(
        (record) => record.kind === 'start' && unresolvedSubmission(record)
      );
      const pendingRestart = records.find(
        (record) => record.kind === 'restart' && unresolvedSubmission(record)
      );
      if (pendingRestart) {
        restartRequest.current = {
          kernelId: pendingRestart.kernelId,
          input: { requestId: pendingRestart.requestId, generation: pendingRestart.generation },
        };
        setRestartReceipt({
          requestId: pendingRestart.requestId,
          status: pendingRestart.status || 'unknown',
        });
      }
      const retainedPendingCommand = records.find(
        (record) => record.kind === 'execution' && unresolvedSubmission(record)
      );
      if (retainedPendingCommand) {
        pendingCommand.current = {
          requestId: retainedPendingCommand.requestId,
          kernelId: retainedPendingCommand.kernelId,
          generation: retainedPendingCommand.generation,
          executionId: retainedPendingCommand.executionId,
        };
        setRunningCommand({ ...pendingCommand.current });
      }
      const retainedPendingPublication = records.find(
        (record) => record.kind === 'publication' && unresolvedSubmission(record)
      );
      if (retainedPendingPublication)
        pendingPublication.current = {
          requestId: retainedPendingPublication.requestId,
          kernelId: retainedPendingPublication.kernelId,
          generation: retainedPendingPublication.generation,
          publicationId: retainedPendingPublication.publicationId,
        };
      const recoverable = records.find((record) => unresolvedSubmission(record) && record.kernelId);
      const admittedStart = records.find(
        (record) => record.kind === 'start' && record.confirmed && record.kernelId
      );
      const selectedKernelId =
        focusedRequest?.kernelId ||
        pendingStart?.kernelId ||
        recoverable?.kernelId ||
        retained?.kernelId ||
        admittedStart?.kernelId;
      const previous = changed
        ? null
        : (ownsPreferred && preferredKernel) ||
          (selectedKernelId && { id: selectedKernelId }) ||
          currentSession.current;
      let kernel = previous;
      if (!kernel && !pendingStart) {
        const kernels = await api.listPrivateRKernels(projectId, {
          workspaceId,
          signal: controller.signal,
        });
        check();
        kernel = kernels.items[0] || null;
      }
      const retainedRestart = kernel?.restart;
      if (kernel) {
        kernel = await api.getPrivateRKernel(projectId, kernel.id, controller.signal);
        check();
      }
      let restart = null;
      const exactRestart = records.find(
        (record) =>
          record.kind === 'restart' &&
          record.confirmed &&
          record.state === 'accepted' &&
          (record.kernelId === kernel?.id || record.replacementKernelId === kernel?.id)
      );
      const restartKernel =
        exactRestart?.kernelId ||
        (!pendingRestart && (kernel?.restart || retainedRestart)
          ? kernel.id
          : !pendingRestart
            ? restartRequest.current?.kernelId
            : null);
      if (restartKernel) {
        restart = await api.getPrivateRRestart(projectId, restartKernel, controller.signal);
        check();
        if (exactRestart && restart.requestId !== exactRestart.requestId)
          throw Object.assign(
            new Error(
              'The restart receipt belongs to a different request. Check session status before continuing.'
            ),
            { code: 'PRIVATE_KERNEL_TRANSPORT_UNKNOWN' }
          );
        if (restart.session) {
          kernel = await api.getPrivateRKernel(projectId, restart.session.id, controller.signal);
          check();
        } else if (restart.previousSession) kernel = restart.previousSession;
      }
      const [history, saved, artifacts] = await Promise.all([
        kernel
          ? api.listPrivateRExecutions(projectId, kernel.id, {
              limit: 30,
              signal: controller.signal,
            })
          : Promise.resolve({ items: [], nextCursor: null }),
        kernel && publicationSupported
          ? api.listPrivateRPublications(projectId, kernel.id, { signal: controller.signal })
          : Promise.resolve({ items: [] }),
        listArtifactVersions(projectId, { signal: controller.signal }),
      ]);
      check();
      const selected = changed
        ? null
        : (ownsPreferred && preferredDetail) ||
          (!retained?.executionId && focusedRequest?.kind !== 'execution'
            ? selectedEntry.current
            : null);
      const retainedCommand = records.find(
        (record) =>
          record.kind === 'execution' &&
          record.confirmed &&
          record.state === 'accepted' &&
          record.kernelId === kernel?.id &&
          record.executionId
      );
      const focusedExecutionId =
        focusedRequest?.kind === 'execution' ? focusedRequest.executionId : null;
      const selectedId =
        focusedExecutionId ||
        (selected && (!selected.kernelId || selected.kernelId === kernel?.id)
          ? selected.id
          : (retained && retained.kernelId === kernel?.id && retained.executionId) ||
            retainedCommand?.executionId ||
            history.items[0]?.id);
      const detail =
        kernel && selectedId
          ? await api.getPrivateRExecution(projectId, kernel.id, selectedId, controller.signal)
          : null;
      check();
      const admittedPending = records.filter(
        (record) => record.confirmed && record.state === 'accepted' && unresolvedSubmission(record)
      );
      for (let index = 0; index < admittedPending.length; index += 4) {
        await Promise.all(
          admittedPending.slice(index, index + 4).map((record) =>
            recovery.checkPrivateSubmissionReceipt(record.requestId, {
              signal: controller.signal,
            })
          )
        );
        check();
      }
      records = recovery
        .getPrivateRecoverySnapshot()
        .records.filter(
          (record) =>
            record.projectId === projectId &&
            (!record.workspaceId || record.workspaceId === workspaceId)
        );
      if (previous && kernel && previous.id !== kernel.id) {
        kernelEpoch.current += 1;
        setSaving(false);
        setBusy(false);
        setRunningCommand(null);
        pendingCommand.current = null;
        setFigureSelection(null);
        setPreviousEvidence({ kernelId: previous.id });
      }
      const pending = pendingCommand.current;
      const commandReceipt = records.find(
        (record) =>
          record.kind === 'execution' &&
          record.requestId === pending?.requestId &&
          record.kernelId === pending?.kernelId &&
          record.generation === pending?.generation
      );
      const commandConfirmed = Boolean(
        pending &&
          (commandReceipt
            ? commandReceipt.confirmed &&
              commandReceipt.state === 'accepted' &&
              commandReceipt.completionKnown &&
              detail?.id === commandReceipt.executionId &&
              detail.completionKnown
            : detail?.id === pending.executionId && detail.completionKnown)
      );
      const memoryDiscarded = Boolean(
        kernel &&
          (terminalStatuses.includes(kernel.status) ||
            (pending && kernel.id === pending.kernelId && kernel.generation !== pending.generation))
      );
      if (commandConfirmed || memoryDiscarded) {
        pendingCommand.current = null;
        setRunningCommand(null);
      }
      const publicationPending = pendingPublication.current;
      const publicationReceipt = records.find(
        (record) =>
          record.kind === 'publication' &&
          record.requestId === publicationPending?.requestId &&
          record.kernelId === publicationPending?.kernelId &&
          record.generation === publicationPending?.generation
      );
      if (
        publicationPending &&
        ((publicationReceipt
          ? publicationReceipt.confirmed &&
            publicationReceipt.state === 'accepted' &&
            ['completed', 'failed'].includes(publicationReceipt.status)
          : saved.items.some(
              (item) =>
                item.id === publicationPending.publicationId &&
                ['completed', 'failed'].includes(item.status)
            )) ||
          (kernel &&
            (terminalStatuses.includes(kernel.status) ||
              (kernel.id === publicationPending.kernelId &&
                kernel.generation !== publicationPending.generation))))
      )
        pendingPublication.current = null;
      const detailRequest = records.find(
        (record) =>
          record.kind === 'execution' &&
          record.confirmed &&
          record.kernelId === kernel?.id &&
          record.executionId === detail?.id
      );
      const latestSelection = recovery.getPrivateRecoverySnapshot().selection;
      const pendingIntent = records.find(
        (record) => record.requestId === latestSelection?.requestId && unresolvedSubmission(record)
      );
      if (
        kernel &&
        !pendingIntent &&
        !records.some((record) => record.kind === 'start' && !record.kernelId)
      ) {
        await saveRecoveredSelection(
          {
            projectId,
            workspaceId,
            kernelId: kernel.id,
            ...(detail?.id ? { executionId: detail.id } : {}),
            ...(detailRequest?.requestId ? { requestId: detailRequest.requestId } : {}),
          },
          { expectedSelection: latestSelection }
        );
        recoveryInspection = {
          ...recoveryInspection,
          selection: recovery.getPrivateRecoverySnapshot().selection,
        };
      }
      check();
      setSession(kernel);
      setJournal(history.items.slice(0, journalLimit));
      setJournalCursor(history.nextCursor || null);
      setEntry(detail);
      setPublications(saved.items);
      setVersions(artifacts.items);
      setPublicationUncertain(
        Boolean(pendingPublication.current) ||
          saved.items.some((item) => ['reserved', 'running', 'unknown'].includes(item.status))
      );
      setUncertain(
        kernel?.status === 'unknown' ||
          Boolean(detail && !detail.completionKnown) ||
          Boolean(pendingCommand.current)
      );
      setInspection(confirmation(kernel));
      if (restart) {
        setRestartReceipt(restart);
        if (['completed', 'failed'].includes(restart.status)) restartRequest.current = null;
        setControlNotice(
          restart.status === 'completed'
            ? 'Restart created a fresh session from the original selected input versions. Unsaved variables and files were discarded; earlier commands were not rerun. Saved artifact versions remain available.'
            : restart.status === 'failed'
              ? 'Restart failed. Inspect session status before starting another session.'
              : 'Restart completion is unconfirmed. Inspect this restart request before continuing.'
        );
      }
    } catch (failure) {
      if (valid()) {
        setError(failure.message);
        if ([401, 403, 404].includes(failure.status)) {
          clearPrivate();
          resetDrafts();
        } else {
          setInspection(null);
          setUncertain(true);
        }
      }
    } finally {
      clearTimeout(timer);
      if (inspectionTimer.current === timer) inspectionTimer.current = null;
      if (valid()) setInspecting(false);
    }
  }
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    requestEpoch.current += 1;
    clearPrivate();
    resetDrafts();
    installation.current = null;
    setError('');
    return () => {
      requestEpoch.current += 1;
      inspectionController.current?.abort();
      clearTimeout(inspectionTimer.current);
    };
  }, [scopeKey, resetDrafts]);
  useEffect(() => {
    requestEpoch.current += 1;
    setInspection(null);
    setInspecting(false);
    setBusy(false);
    setControlBusy(false);
    setSaving(false);
    if (enabled && !blocked) void refreshRef.current();
    return () => {
      requestEpoch.current += 1;
      inspectionController.current?.abort();
      clearTimeout(inspectionTimer.current);
    };
  }, [scopeKey, enabled, publicationSupported, connection.epoch, blocked]);
  useEffect(() => {
    if (
      enabled &&
      ((installation.current && !recovered.scope) ||
        (recovered.error && !recovered.scope) ||
        (installation.current && recovered.scope && recovered.scope.userId !== Number(userId)))
    ) {
      requestEpoch.current += 1;
      clearPrivate();
      resetDrafts();
      setError(
        'Private R request recovery could not confirm account access. Inspect session status before continuing.'
      );
    }
  }, [enabled, recovered.scope, recovered.error, userId, resetDrafts]);
  const start = async () => {
    if (!inspected || active || busy || controlBusy || inspecting || recoveryBlocked) return;
    const input = {
      requestId: startRequest.current || crypto.randomUUID(),
      workspaceId,
      analysisObjectId: objectId || null,
      environment,
      inputs: versions
        .filter((version) => selectedInputs.includes(version.versionId))
        .map((version) => version.reference),
    };
    startRequest.current = input.requestId;
    const value = await runRequest(() =>
      recovery.submitPrivateWithRecovery(projectId, 'start', input, {
        workspaceId,
        userId,
        post: (body) => api.startPrivateRKernel(projectId, body),
      })
    );
    if (value) {
      kernelEpoch.current += 1;
      setSaving(false);
      setSession(value);
      setInspection(confirmation(value));
      setEntry(null);
      setJournal([]);
      setJournalCursor(null);
      setPublications([]);
      setFigureSelection(null);
      setPublicationForm((form) => ({
        ...form,
        type: form.type === 'figure' ? 'object' : form.type,
        previousVersionId: '',
      }));
      setPublicationUncertain(false);
      setUncertain(value.status === 'unknown');
      setControlNotice('');
      setRestartReceipt(null);
      setPreviousEvidence(null);
      restartRequest.current = null;
      startRequest.current = null;
    }
  };
  const execute = async (source) => {
    if (
      !inspected ||
      inspecting ||
      busy ||
      controlBusy ||
      runningCommand ||
      session?.status !== 'ready' ||
      uncertain ||
      publicationUncertain ||
      recoveryBlocked
    )
      return;
    const command = {
      requestId: crypto.randomUUID(),
      kernelId: session.id,
      generation: session.generation,
    };
    pendingCommand.current = command;
    setRunningCommand(command);
    setControlNotice('');
    let failure;
    const value = await runRequest(async () => {
      try {
        return await recovery.submitPrivateWithRecovery(
          projectId,
          'execution',
          { requestId: command.requestId, source },
          {
            workspaceId,
            userId,
            kernelId: session.id,
            generation: session.generation,
            post: (body) => api.executePrivateRKernel(projectId, session.id, body),
          }
        );
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    if (pendingCommand.current === command) {
      if (
        value?.completionKnown ||
        notAdmitted(failure) ||
        (failure && [400, 409, 413, 422].includes(failure.status))
      ) {
        pendingCommand.current = null;
        setRunningCommand(null);
      } else if (value) {
        command.executionId = value.id;
        setRunningCommand({ ...command });
      } else setUncertain(true);
    }
    if (value) {
      const selected = recovery.getPrivateRecoverySnapshot().selection;
      const currentIntent =
        !selected ||
        (selected.kernelId === session.id &&
          (!selected.requestId || selected.requestId === command.requestId) &&
          (!selected.executionId || selected.executionId === value.id));
      if (currentIntent) {
        setEntry(value);
        setUncertain(!value.completionKnown);
      }
      await refresh(
        currentIntent ? { kernel: session, detail: value, intentRequestId: command.requestId } : {}
      );
    }
  };
  const stop = async () => {
    const value = await runRequest(
      async () => {
        const result = await api.stopPrivateRKernel(projectId, session.id);
        if (
          terminalStatuses.includes(result.status) &&
          result.id === session.id &&
          result.generation === session.generation
        )
          await recovery.clearKernelPrivateRecovery(projectId, session.id, session.generation);
        return result;
      },
      { control: true }
    );
    if (value) {
      inspectionController.current?.abort();
      clearTimeout(inspectionTimer.current);
      setInspecting(false);
      kernelEpoch.current += 1;
      setSaving(false);
      setBusy(false);
      if (terminalStatuses.includes(value.status)) {
        setRunningCommand(null);
        pendingCommand.current = null;
        pendingPublication.current = null;
        setPublicationUncertain(false);
      }
      setSession(value);
      setInspection(confirmation(value));
      setConfirmStop(false);
      setUncertain(value.status === 'unknown' || Boolean(pendingCommand.current));
      startRequest.current = null;
      setControlBusy(false);
    }
  };
  const interrupt = async () => {
    const command = pendingCommand.current;
    const input = {
      requestId: crypto.randomUUID(),
      generation: session.generation,
      ...(command?.kernelId === session.id
        ? { executionRequestId: command.requestId }
        : session.activeExecutionId
          ? { executionId: session.activeExecutionId }
          : {}),
    };
    const value = await runRequest(
      () => api.interruptPrivateRKernel(projectId, session.id, input),
      { control: true }
    );
    if (!value) return;
    if (value.idleConfirmed && value.execution) {
      kernelEpoch.current += 1;
      setSaving(false);
      pendingCommand.current = null;
      setBusy(false);
      setRunningCommand(null);
      setControlBusy(false);
    }
    setSession(value.session);
    setInspection(value.idleConfirmed ? confirmation(value.session) : null);
    if (value.execution) setEntry(value.execution);
    setUncertain(!value.idleConfirmed || value.session?.status === 'unknown');
    setControlNotice(
      value.outcome === 'interrupted' && value.idleConfirmed
        ? 'R command interrupted and the session is idle. Earlier variables remain, but interrupted code may already have changed them. Inspect before continuing.'
        : value.outcome === 'already-completed' && value.idleConfirmed
          ? 'The command completed before interruption was confirmed. Its retained result remains available.'
          : value.outcome === 'idle' && value.idleConfirmed
            ? 'The session is already idle. No command was interrupted.'
            : 'Interruption is unconfirmed. Refresh session status or explicitly restart before continuing. No source will be rerun automatically.'
    );
    const history = await runRequest(() => refreshJournal(value.session), { control: true });
    if (history) {
      setJournal(history.items);
      setJournalCursor(history.nextCursor || null);
    }
    if (value.idleConfirmed) await refresh({ kernel: value.session, detail: value.execution });
  };
  const restart = async (inspect = false) => {
    const epoch = requestEpoch.current;
    const scope = scopeKey;
    const generationEpoch = kernelEpoch.current;
    const request = restartRequest.current || {
      kernelId:
        inspect && !session.restart && session.restartedFromKernelId
          ? session.restartedFromKernelId
          : session.id,
      input: { requestId: crypto.randomUUID(), generation: session.generation },
    };
    restartRequest.current = request;
    let failure;
    const value = await runRequest(
      async () => {
        try {
          if (inspect) {
            const record = recovery
              .getPrivateRecoverySnapshot()
              .records.find(
                (item) => item.kind === 'restart' && item.requestId === request.input.requestId
              );
            if (record) {
              await recovery.checkPrivateSubmissionReceipt(record.requestId);
              const confirmed = recovery
                .getPrivateRecoverySnapshot()
                .records.find((item) => item.requestId === record.requestId);
              if (!confirmed?.confirmed || confirmed.state !== 'accepted')
                throw Object.assign(
                  new Error(
                    'This restart is still unconfirmed. Keep its request identifier and check again.'
                  ),
                  { code: 'PRIVATE_SUBMISSION_UNCONFIRMED' }
                );
            }
            return await api.getPrivateRRestart(projectId, request.kernelId);
          }
          const result = await recovery.submitPrivateWithRecovery(
            projectId,
            'restart',
            request.input,
            {
              workspaceId,
              userId,
              kernelId: request.kernelId,
              generation: request.input.generation,
              post: (body) => api.restartPrivateRKernel(projectId, request.kernelId, body),
            }
          );
          if (
            result.status === 'completed' &&
            result.session?.id &&
            result.session.id !== request.kernelId &&
            result.session.generation &&
            (!result.submission || result.submission.replacementKernelId === result.session.id) &&
            result.previousSession?.id === request.kernelId &&
            result.previousSession.generation === request.input.generation &&
            terminalStatuses.includes(result.previousSession.status)
          )
            await recovery.clearKernelPrivateRecovery(
              projectId,
              request.kernelId,
              request.input.generation
            );
          return result;
        } catch (error) {
          failure = error;
          throw error;
        }
      },
      { control: true }
    );
    if (!value) {
      if (
        epoch === requestEpoch.current &&
        generationEpoch === kernelEpoch.current &&
        scope === currentScope.current
      ) {
        if (
          !inspect &&
          failure &&
          ![
            'PRIVATE_KERNEL_TRANSPORT_UNKNOWN',
            'PRIVATE_KERNEL_RESPONSE_INVALID',
            'TARGET_EXECUTION_UNCONFIRMED',
            'PRIVATE_SUBMISSION_UNCONFIRMED',
            'PRIVATE_SUBMISSION_RECOVERY_REQUIRED',
            'PRIVATE_SUBMISSION_RECOVERY_CHANGED',
          ].includes(failure.code)
        ) {
          restartRequest.current = null;
          setRestartReceipt(null);
          setConfirmRestart(false);
        } else
          setRestartReceipt(
            (receipt) => receipt || { status: 'unknown', requestId: request.input.requestId }
          );
      }
      return;
    }
    setRestartReceipt(value);
    setConfirmRestart(false);
    if (value.session) {
      inspectionController.current?.abort();
      clearTimeout(inspectionTimer.current);
      setInspecting(false);
      kernelEpoch.current += 1;
      setSaving(false);
      if (value.status === 'completed') {
        pendingCommand.current = null;
        pendingPublication.current = null;
        setRunningCommand(null);
        setPublicationUncertain(false);
      }
      setBusy(false);
      setControlBusy(false);
      setSession(value.session);
      setInspection(confirmation(value.session));
      setEntry(null);
      setJournal([]);
      setJournalCursor(null);
      setPublications([]);
      setFigureSelection(null);
      setUncertain(value.session.status === 'unknown');
      setPreviousEvidence({ kernelId: value.previousKernelId, session: value.previousSession });
      setControlNotice(
        value.status === 'completed'
          ? 'Restart created a fresh session from the original selected input versions. Unsaved variables and files were discarded; earlier commands were not rerun. Saved artifact versions remain available.'
          : value.status === 'failed'
            ? 'Restart failed. Inspect session status before starting another session.'
            : 'Restart completion is unconfirmed. Refresh status or inspect this restart request. Earlier commands will not be rerun automatically; saved artifact versions remain available.'
      );
      if (['completed', 'failed'].includes(value.status)) restartRequest.current = null;
    } else {
      setSession(value.previousSession || session);
      setUncertain(['unknown', 'starting', 'stopping'].includes(value.status));
      setControlNotice(
        value.status === 'failed'
          ? 'Restart failed. Inspect session status before starting another session.'
          : 'Restart completion is unconfirmed. Refresh status or inspect this restart request. Earlier commands will not be rerun automatically.'
      );
      if (value.status === 'failed') restartRequest.current = null;
    }
  };
  const inspectPrevious = async () => {
    const kernelId = previousEvidence?.kernelId || session?.restartedFromKernelId;
    if (!kernelId) return;
    const value = await runRequest(async () => ({
      kernelId,
      session: await api.getPrivateRKernel(projectId, kernelId),
      journal: (await api.listPrivateRExecutions(projectId, kernelId)).items,
      publications: publicationSupported
        ? (await api.listPrivateRPublications(projectId, kernelId)).items
        : [],
    }));
    if (value) setPreviousEvidence(value);
  };
  const openEntry = async (item, kernelId = session.id) => {
    const value = await runRequest(async () => {
      const result = await api.getPrivateRExecution(projectId, kernelId, item.id);
      if (kernelId === session?.id)
        await saveRecoveredSelection({ projectId, workspaceId, kernelId, executionId: result.id });
      return result;
    });
    if (value) setEntry(value);
  };
  const loadOlder = async () => {
    if (!session || !journalCursor || busy || controlBusy || inspecting) return;
    const pageEpoch = inspectionEpoch.current;
    const value = await runRequest(() =>
      api.listPrivateRExecutions(projectId, session.id, { limit: 30, before: journalCursor })
    );
    if (value && pageEpoch === inspectionEpoch.current) {
      setJournal((items) =>
        [
          ...items,
          ...value.items.filter((item) => !items.some((existing) => existing.id === item.id)),
        ].slice(-journalLimit)
      );
      setJournalCursor(value.nextCursor || null);
    }
  };
  const forget = async () => {
    const requestId = forgetRequest;
    if (!requestId) return;
    const value = await runRequest(async () => {
      await recovery.forgetPrivateSubmission(requestId);
      return true;
    });
    if (!value) return;
    requestEpoch.current += 1;
    setBusy(false);
    setControlBusy(false);
    setForgetRequest(null);
    setInspection(null);
    if (pendingCommand.current?.requestId === requestId) {
      pendingCommand.current = null;
      setRunningCommand(null);
      setEntry(null);
    }
    if (pendingPublication.current?.requestId === requestId) {
      pendingPublication.current = null;
      setPublicationUncertain(false);
    }
    if (restartRequest.current?.input.requestId === requestId) {
      restartRequest.current = null;
      setRestartReceipt(null);
    }
    if (startRequest.current === requestId) startRequest.current = null;
    await refresh();
  };
  const inspectSaved = async (version) => {
    setSavedPreview(null);
    const value = await runRequest(async () => ({
      version: await getArtifactVersion(projectId, version.versionId),
      preview: await previewArtifactVersion(projectId, version.versionId, { limit: 25 }),
    }));
    if (value) setSavedPreview(value);
  };
  const chooseFigure = (index) => {
    setFigureSelection({
      kernelId: session.id,
      executionId: entry.id,
      index,
      order: entry.order,
      sha256: entry.result.figures[index].sha256,
    });
    setPublicationForm({ type: 'figure', binding: '', name: '', previousVersionId: '' });
  };
  const publish = async (event) => {
    event.preventDefault();
    if (
      !inspected ||
      inspecting ||
      runningCommand ||
      !session ||
      !publicationSupported ||
      busy ||
      controlBusy ||
      publicationUncertain ||
      recoveryBlocked ||
      !publicationForm.name.trim() ||
      (publicationForm.type === 'figure'
        ? !canSaveFigure
        : !canSaveBinding || !publicationForm.binding)
    )
      return;
    const epoch = requestEpoch.current;
    const generationEpoch = kernelEpoch.current;
    const scope = scopeKey;
    setSaving(true);
    try {
      setSavedPreview(null);
      const input = {
        requestId: crypto.randomUUID(),
        type: publicationForm.type,
        name: publicationForm.name.trim(),
        ...(publicationForm.type === 'figure'
          ? { executionId: figureSelection.executionId, figureIndex: figureSelection.index }
          : { binding: publicationForm.binding }),
        ...(publicationForm.previousVersionId
          ? { previousVersionId: publicationForm.previousVersionId }
          : {}),
      };
      const pending = {
        requestId: input.requestId,
        kernelId: session.id,
        generation: session.generation,
      };
      pendingPublication.current = pending;
      setPublicationUncertain(true);
      let failure;
      const value = await runRequest(
        async () => {
          try {
            return await recovery.submitPrivateWithRecovery(projectId, 'publication', input, {
              workspaceId,
              userId,
              kernelId: session.id,
              generation: session.generation,
              post: (body) => api.publishPrivateROutput(projectId, session.id, body),
            });
          } catch (error) {
            failure = error;
            throw error;
          }
        },
        { publication: true }
      );
      if (pendingPublication.current === pending) {
        if (
          (value && ['completed', 'failed'].includes(value.publication.status)) ||
          notAdmitted(failure) ||
          (failure && [400, 409, 413, 422].includes(failure.status))
        ) {
          pendingPublication.current = null;
          setPublicationUncertain(false);
        } else if (value) pending.publicationId = value.publication.id;
      }
      if (!value) return;
      setPublications((items) => [
        { ...value.publication, version: value.version },
        ...items.filter((item) => item.id !== value.publication.id),
      ]);
      setPublicationUncertain(
        Boolean(pendingPublication.current) ||
          ['reserved', 'running', 'unknown'].includes(value.publication.status)
      );
      if (value.version) {
        setVersions((items) => [
          value.version,
          ...items.filter((item) => item.versionId !== value.version.versionId),
        ]);
        setPublicationForm((form) => ({ ...form, name: '', previousVersionId: '' }));
      }
      const refreshed = await runRequest(async () => ({
        kernel: await api.getPrivateRKernel(projectId, session.id),
        entries: await refreshJournal(session),
        artifacts: (await listArtifactVersions(projectId)).items,
      }));
      if (!refreshed) return;
      setSession(refreshed.kernel);
      setInspection(confirmation(refreshed.kernel));
      setJournal(refreshed.entries.items);
      setJournalCursor(refreshed.entries.nextCursor || null);
      setUncertain(refreshed.kernel.status === 'unknown');
      setVersions(refreshed.artifacts);
      if (value.version) await inspectSaved(value.version);
    } finally {
      if (
        epoch === requestEpoch.current &&
        generationEpoch === kernelEpoch.current &&
        scope === currentScope.current
      )
        setSaving(false);
    }
  };
  const replacements = versions.filter(
    (version) =>
      version.canReplace &&
      String(version.ownerId) === String(userId) &&
      version.format.id === outputFormats[publicationForm.type]
  );
  const canSaveBinding =
    inspected &&
    !inspecting &&
    !runningCommand &&
    session?.status === 'ready' &&
    !uncertain &&
    !publicationUncertain &&
    !recoveryBlocked;
  const canSaveFigure =
    inspected &&
    !inspecting &&
    !runningCommand &&
    figureSelection &&
    figureSelection.kernelId === session?.id &&
    !recoveryBlocked;
  const canInterrupt =
    !blocked &&
    interruptSupported &&
    session?.generation &&
    (runningCommand?.kernelId === session.id ||
      session.status === 'running' ||
      session.activeExecutionId) &&
    !controlBusy;
  const canRestart =
    !blocked &&
    session?.generation &&
    !controlBusy &&
    !session.restart &&
    !retainedRequests.some((record) => record.kind === 'restart' && unresolvedSubmission(record)) &&
    !['starting', 'stopping'].includes(session.status);
  const selectObject = (id) => {
    setObjectId(id);
    startRequest.current = null;
  };
  const toggleInput = (versionId, selected) => {
    setSelectedInputs((items) =>
      selected ? [...items, versionId] : items.filter((value) => value !== versionId)
    );
    startRequest.current = null;
  };

  return {
    blocked,
    enabled,
    error,
    setError,
    inspecting,
    inspected,
    uncertain,
    controlNotice,
    runningCommand,
    retainedRequests,
    forgetRequest,
    setForgetRequest,
    busy,
    controlBusy,
    refresh,
    forget,
    artifactPolicy,
    active,
    objectId,
    selectObject,
    recoveryBlocked,
    restartPending: Boolean(restartRequest.current),
    session,
    environment,
    start,
    interruptSupported,
    canInterrupt,
    interrupt,
    confirmRestart,
    setConfirmRestart,
    canRestart,
    restart,
    restartReceipt,
    confirmStop,
    setConfirmStop,
    stop,
    versions,
    selectedInputs,
    toggleInput,
    execute,
    publicationUncertain,
    entry,
    publicationSupported,
    chooseFigure,
    publish,
    publicationForm,
    setPublicationForm,
    figureSelection,
    replacements,
    saving,
    canSaveFigure,
    canSaveBinding,
    publications,
    inspectSaved,
    savedPreview,
    setSavedPreview,
    journal,
    openEntry,
    journalCursor,
    loadOlder,
    previousEvidence,
    inspectPrevious,
  };
}
