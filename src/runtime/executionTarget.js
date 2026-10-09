export const TARGET_DISCONNECTED_MESSAGE = 'The selected server is disconnected. Reconnect through Connection details before starting more work.';
export const TARGET_UNCONFIRMED_MESSAGE = 'The server connection changed before completion was confirmed. Reconnect to the same server and inspect execution history before submitting work again. No work was rerun automatically.';
export const TARGET_CHANGED_MESSAGE = 'The server connection changed while this record was loading. Reconnect and refresh to inspect the selected server.';
export const TARGET_CHECKING_MESSAGE = 'The selected server connection has not been confirmed. Reconnect through Connection details before starting work.';

const stores = new WeakMap();
const browser = Object.freeze({ target: null, blocked: false, state: 'connected', identity: '', epoch: 0, error: '' });

function nativeShell() {
  const shell = window.desktopShell;
  return shell && typeof shell.getCurrentTarget === 'function' ? shell : null;
}

function createStore(shell) {
  let snapshot = Object.freeze({ target: null, blocked: true, state: 'checking', identity: '', epoch: 0, error: '' });
  const listeners = new Set();
  let references = 0;
  let unsubscribe;
  let initialization;
  let activeEpoch = 0;
  const emit = () => { for (const listener of listeners) listener(); };
  function update(target, error = '') {
    const identity = target?.serviceIdentity || `${target?.id || ''}:${target?.endpoint || ''}`;
    const state = !target ? 'unavailable' : target.status === 'connected' && (!target.sshTunnel || target.sshTunnel.state === 'connected') ? 'connected' : 'disconnected';
    const changed = identity !== snapshot.identity || state !== snapshot.state;
    snapshot = Object.freeze({ target, blocked: state !== 'connected', state, identity, epoch: snapshot.epoch + (changed ? 1 : 0), error });
    emit();
  }
  function retain() {
    references += 1;
    if (references !== 1) return;
    const activation = ++activeEpoch;
    let receivedStatus = false;
    let targetId = snapshot.target?.id;
    unsubscribe = typeof shell.onTargetStatus === 'function' ? shell.onTargetStatus(target => {
      if (activation !== activeEpoch || !target || (targetId && target.id && targetId !== target.id)) return;
      receivedStatus = true;
      targetId = target.id || targetId;
      update(target);
    }) : null;
    let initial;
    try { initial = shell.getCurrentTarget(); } catch (error) { initial = Promise.reject(error); }
    initialization = Promise.resolve(initial).then(target => {
      if (activation === activeEpoch && !receivedStatus) {
        targetId = target?.id || targetId;
        update(target && typeof target === 'object' ? target : null);
      }
    }).catch(() => { if (activation === activeEpoch && !receivedStatus) update(null, 'Connection details are unavailable.'); });
  }
  function release() {
    references -= 1;
    if (references !== 0) return;
    activeEpoch += 1;
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = null;
    initialization = null;
  }
  return {
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); retain(); return () => { listeners.delete(listener); release(); }; },
    async acquire() { retain(); await initialization; return release; },
  };
}

function currentStore() {
  const shell = nativeShell();
  if (!shell) return null;
  if (!stores.has(shell)) stores.set(shell, createStore(shell));
  return stores.get(shell);
}

export const getExecutionTargetSnapshot = () => currentStore()?.snapshot() || browser;
export const subscribeExecutionTarget = listener => currentStore()?.subscribe(listener) || (() => {});

export function isExecutionTargetError(error) {
  return ['TARGET_DISCONNECTED', 'TARGET_UNAVAILABLE', 'TARGET_EXECUTION_UNCONFIRMED', 'TARGET_CHANGED'].includes(error?.code);
}

function blockedError(snapshot) {
  return Object.assign(new Error(snapshot.state === 'disconnected' ? TARGET_DISCONNECTED_MESSAGE : TARGET_CHECKING_MESSAGE), {
    code: snapshot.state === 'disconnected' ? 'TARGET_DISCONNECTED' : 'TARGET_UNAVAILABLE',
  });
}

export async function withExecutionTarget(action, { mutation = false } = {}) {
  const store = currentStore();
  if (!store) return action();
  const release = await store.acquire();
  let stopWatching;
  try {
    const initial = store.snapshot();
    if (initial.blocked) throw blockedError(initial);
    const changed = () => Object.assign(new Error(mutation ? TARGET_UNCONFIRMED_MESSAGE : TARGET_CHANGED_MESSAGE), {
      code: mutation ? 'TARGET_EXECUTION_UNCONFIRMED' : 'TARGET_CHANGED',
    });
    const lost = new Promise((_, reject) => {
      stopWatching = store.subscribe(() => { if (store.snapshot().epoch !== initial.epoch) reject(changed()); });
    });
    const dispatched = Promise.resolve().then(() => {
      if (store.snapshot().epoch !== initial.epoch) throw changed();
      return action();
    });
    const result = await Promise.race([dispatched, lost]);
    if (store.snapshot().epoch !== initial.epoch) throw changed();
    return result;
  } finally {
    stopWatching?.();
    release();
  }
}
