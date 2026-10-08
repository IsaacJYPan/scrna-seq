import { describe, expect, it } from 'vitest';

const { preflightPrivateR, privateREnvironment, validatePrivateROptions } = require('./configure-private-r');
const options = { image: `traceomics-r@sha256:${'a'.repeat(64)}`, socket: '/run/user/10001/docker.sock', workRoot: '/srv/traceomics-expert' };
const deployment = { APP_DEPLOYMENT_MODE: 'private' };
function dependencies({ rootless = true, labels = '', ids = '', profile = true, uid = 10001 } = {}) {
  const commands = [];
  return { commands, filesystem: {
    realpathSync: value => value,
    existsSync: () => true,
    mkdtempSync: value => `${value}test`, chmodSync() {}, mkdirSync() {}, writeFileSync() {}, rmSync() {},
    lstatSync: value => ({ uid, gid: 10001, mode: 0o700,
      isSocket: () => value === options.socket, isDirectory: () => value === options.workRoot, isSymbolicLink: () => false }),
  }, runDocker: args => {
    commands.push(args);
    if (args.includes('info')) return JSON.stringify(rootless ? ['name=rootless'] : []);
    if (args.includes('ps')) return args.includes('{{.ID}}') ? ids : labels;
    if (args.includes('inspect')) return `sha256:${'b'.repeat(64)}`;
    return profile ? 'private-r-profile-ok' : '';
  } };
}
describe('private R setup preflight', () => {
  it('checks the isolated daemon and image before generating automatic role access', () => {
    const deps = dependencies();
    const identity = preflightPrivateR(options, deployment, deps);
    expect(identity).toEqual({ uid: 10001, gid: 10001 });
    const scriptCheck = deps.commands.find(args => args.includes('run'));
    expect(scriptCheck).toContain('--network=none');
    expect(scriptCheck).toContain('--read-only');
    const first = privateREnvironment(options, identity);
    const second = privateREnvironment(options, identity);
    expect(first).toContain('EXPERT_R_ACCESS_POLICY=project-roles');
    expect(first).toContain('PRIVATE_R_KERNEL_ENABLED=true');
    expect(first).toMatch(/EXPERT_R_SANDBOX_TOKEN=[a-f0-9]{64}\n/);
    expect(first).not.toBe(second);
  });
  it('rejects public mode, mutable images, system sockets and unsafe paths', () => {
    expect(() => validatePrivateROptions(options, { APP_DEPLOYMENT_MODE: 'demo' })).toThrow(/private/);
    expect(() => validatePrivateROptions({ ...options, image: 'traceomics-r:latest' }, deployment)).toThrow(/immutable/);
    expect(() => validatePrivateROptions({ ...options, socket: '/var/run/docker.sock' }, deployment)).toThrow(/application Docker/);
    expect(() => validatePrivateROptions({ ...options, workRoot: '/srv/../etc' }, deployment)).toThrow(/normalized/);
    expect(() => validatePrivateROptions({ ...options, workRoot: '/srv/$HOME' }, deployment)).toThrow(/substitutions/);
  });
  it('refuses unverified isolation, unrelated workloads, inaccessible profiles and mismatched ownership', () => {
    expect(() => preflightPrivateR(options, deployment, dependencies({ rootless: false }))).toThrow(/rootless/);
    expect(() => preflightPrivateR(options, deployment, dependencies({ labels: '', ids: 'unrelated' }))).toThrow(/unrelated workloads/);
    expect(() => preflightPrivateR(options, deployment, dependencies({ profile: false }))).toThrow(/profile and private input/);
    expect(() => preflightPrivateR(options, deployment, dependencies({ uid: 0 }))).toThrow(/APP_UID/);
  });
});
