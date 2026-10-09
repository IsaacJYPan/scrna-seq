import { afterEach, expect, it, vi } from 'vitest';
import { getExecutionTargetSnapshot, subscribeExecutionTarget, withExecutionTarget } from './executionTarget';

const target = { id: 'lab', name: 'Lab server', endpoint: 'https://analysis.example.test', serviceIdentity: 'selected-service', status: 'connected', sshTunnel: { state: 'connected' } };
function shell(initial = target) {
  let notify;
  const unsubscribe = vi.fn();
  window.desktopShell = { getCurrentTarget: vi.fn(async () => initial), onTargetStatus: vi.fn(listener => { notify = listener; return unsubscribe; }) };
  return { notify: value => notify(value), unsubscribe };
}
afterEach(() => { delete window.desktopShell; });

it('uses the browser service directly without inventing remote connection evidence', async () => {
  const action = vi.fn(async () => 42);
  expect(await withExecutionTarget(action, { mutation: true })).toBe(42);
  expect(action).toHaveBeenCalledOnce();
  expect(getExecutionTargetSnapshot()).toMatchObject({ target: null, blocked: false });
});

it('confirms native authority before dispatch and shares a single subscription across requests', async () => {
  let confirm;
  const native = shell();
  window.desktopShell.getCurrentTarget.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
  const action = vi.fn(async () => 42);
  const first = withExecutionTarget(action, { mutation: true });
  const second = withExecutionTarget(action);
  expect(action).not.toHaveBeenCalled();
  expect(getExecutionTargetSnapshot().blocked).toBe(true);
  confirm(target);
  expect(await Promise.all([first, second])).toEqual([42, 42]);
  expect(window.desktopShell.getCurrentTarget).toHaveBeenCalledOnce();
  expect(window.desktopShell.onTargetStatus).toHaveBeenCalledOnce();
  expect(native.unsubscribe).toHaveBeenCalledOnce();
});

it.each([
  [{ ...target, status: 'disconnected', sshTunnel: { state: 'disconnected' } }, 'TARGET_DISCONNECTED'],
  [{ ...target, status: 'connected', sshTunnel: { state: 'connecting' } }, 'TARGET_DISCONNECTED'],
  [null, 'TARGET_UNAVAILABLE'],
])('blocks an unconfirmed native target before any server request: %s', async (initial, code) => {
  shell(initial);
  const action = vi.fn();
  await expect(withExecutionTarget(action, { mutation: true })).rejects.toMatchObject({ code });
  expect(action).not.toHaveBeenCalled();
});

it('fails closed when native target details cannot be read', async () => {
  shell(); window.desktopShell.getCurrentTarget.mockRejectedValue(new Error('private IPC details'));
  const action = vi.fn();
  await expect(withExecutionTarget(action)).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  expect(action).not.toHaveBeenCalled();
  expect(getExecutionTargetSnapshot().error).toBe('Connection details are unavailable.');
});

it('rejects an in-flight mutation immediately on tunnel loss and never replays its accepted request', async () => {
  const native = shell(); let finish; let started;
  const began = new Promise(resolve => { started = resolve; });
  const action = vi.fn(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const result = withExecutionTarget(action, { mutation: true });
  await began;
  native.notify({ ...target, status: 'disconnected', sshTunnel: { state: 'disconnected' } });
  await expect(result).rejects.toMatchObject({ code: 'TARGET_EXECUTION_UNCONFIRMED' });
  finish({ id: 'late-run' });
  await Promise.resolve();
  expect(action).toHaveBeenCalledOnce();
  expect(native.unsubscribe).toHaveBeenCalledOnce();
});

it('rejects a late read after disconnect and reconnect even when the target identity matches', async () => {
  const native = shell(); let finish; let started;
  const began = new Promise(resolve => { started = resolve; });
  const keep = subscribeExecutionTarget(() => {});
  const result = withExecutionTarget(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  await began;
  native.notify({ ...target, sshTunnel: { state: 'disconnected' } });
  native.notify(target);
  finish({ private: 'stale receipt' });
  await expect(result).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  expect(getExecutionTargetSnapshot().blocked).toBe(false);
  keep();
});

it('retains window-bound identity and does not replace a loss event with delayed initial metadata', async () => {
  let initial;
  const native = shell(); window.desktopShell.getCurrentTarget.mockImplementation(() => new Promise(resolve => { initial = resolve; }));
  const release = subscribeExecutionTarget(() => {});
  native.notify({ ...target, sshTunnel: { state: 'disconnected' } });
  initial(target); await Promise.resolve();
  native.notify({ ...target, id: 'other-window', name: 'Other server' });
  expect(getExecutionTargetSnapshot()).toMatchObject({ blocked: true, target: { id: 'lab', name: 'Lab server' } });
  release(); expect(native.unsubscribe).toHaveBeenCalledOnce();
});

it('keeps same-service metadata updates from invalidating a pending confirmed request', async () => {
  const native = shell(); let finish; let started;
  const began = new Promise(resolve => { started = resolve; });
  const result = withExecutionTarget(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  await began;
  native.notify({ ...target, name: 'Updated connection label' });
  finish(42);
  expect(await result).toBe(42);
});

it('rechecks connection authority before a queued action can dispatch after a loss event', async () => {
  const native = shell();
  const keep = subscribeExecutionTarget(() => {});
  await withExecutionTarget(() => null);
  const action = vi.fn(async () => 42);
  const result = withExecutionTarget(action, { mutation: true });
  await Promise.resolve();
  await Promise.resolve();
  native.notify({ ...target, sshTunnel: { state: 'disconnected' } });
  await expect(result).rejects.toMatchObject({ code: 'TARGET_EXECUTION_UNCONFIRMED' });
  expect(action).not.toHaveBeenCalled();
  keep();
});
