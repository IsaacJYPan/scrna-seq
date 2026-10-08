import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { environmentFixture } = require('./_r-environment-test-utils');
const env = require('./rEnvironment');
const { getExpertREnvironment } = require('./expertSandboxClient');
const { probeExpertRRuntime } = require('./expertRAccess');
const { EXPERT_R_RESOURCE_POLICY_VERSION, storedExpertRParams } = require('./expertR');
const servers = [], directories = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function service(handler) {
  const server = http.createServer(handler); servers.push(server); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'a'.repeat(64) };
}
describe('immutable R environments', () => {
  it('canonicalizes inventory order and binds every package, system dependency and runtime field', () => {
    const { manifest, reference } = environmentFixture();
    expect(env.summarizeEnvironmentManifest({ ...manifest, packages: [...manifest.packages].reverse() })).toEqual(reference);
    for (const mutate of [m => m.packages[1].version = '5.4.0', m => m.systemPackages[0].version = '2.40', m => m.r.version = '4.5.4', m => m.packages[1].source.repository = 'Bioconductor', m => m.runtime.architecture = 'arm64']) {
      const changed = structuredClone(manifest); mutate(changed);
      expect(env.summarizeEnvironmentManifest(changed).id).not.toBe(reference.id);
    }
    expect(reference.snapshotScope).toBe('container-userspace');
    expect(env.validateEnvironmentManifest(manifest).runtime.kernel).toBe('worker-host');
  });
  it('pins parameters and refuses a stale or incompatible environment without substitution', () => {
    const { manifest, reference } = environmentFixture();
    const params = { profileId: manifest.profileId, script: 'print(1)', inputIds: [] };
    expect(storedExpertRParams(env.pinExpertREnvironment(params,manifest)).environment).toEqual(reference);
    expect(() => env.pinExpertREnvironment({ ...params, environment: environmentFixture('b').reference },manifest)).toThrow(/exact R environment/);
    expect(() => env.pinExpertREnvironment({ ...params, profileId: 'other' },manifest)).toThrow(/profile/);
  });
  it.each(['C:/Users/researcher/private','/home/researcher/private','password=secret','https://name:secret@example.test/x'])('rejects native paths and credentials in source/version metadata: %s', value => {
    for (const field of ['remoteHost','remoteOwner','remoteRepo','remoteRef','gitBranch','repository']) {
      const { manifest } = environmentFixture(); manifest.packages[1].source[field] = value;
      expect(() => env.validateEnvironmentManifest(manifest)).toThrow();
    }
    for (const field of ['version','platform']) { const { manifest } = environmentFixture(); manifest.r[field] = value; expect(() => env.validateEnvironmentManifest(manifest)).toThrow(); }
  });
  it('rejects incomplete, duplicate, unbounded, mutable and authenticated-origin locks', () => {
    for (const mutate of [m => m.packages = [], m => m.packages.push(m.packages[0]), m => m.runtime.imageReference = 'traceomics-r:latest', m => m.runtime.imageId = `sha256:${'b'.repeat(64)}`, m => m.packages[1].source.url = 'https://user:secret@example.test/archive', m => m.packages[1].source.url = 'https://example.test/archive?token=secret', m => m.runtime.distribution.version = '/etc/version', m => m.lock.sourceArchivesIncluded = true]) {
      const { manifest } = environmentFixture(); mutate(manifest); expect(() => env.validateEnvironmentManifest(manifest)).toThrow();
    }
  });
  it('reads only authenticated, bounded valid manifests and bounds an unresponsive service', async () => {
    const { manifest } = environmentFixture();
    const config = await service((req,res) => { expect(req.url).toBe('/environment'); expect(req.headers.authorization).toBe(`Bearer ${'a'.repeat(64)}`); res.end(env.environmentBytes(manifest)); });
    expect(await getExpertREnvironment(config)).toEqual(env.validateEnvironmentManifest(manifest));
    const oversized = await service((_req,res) => res.end('x'.repeat(env.MAX_ENVIRONMENT_BYTES+1)));
    await expect(getExpertREnvironment(oversized)).rejects.toMatchObject({ code: 'R_ENVIRONMENT_INVALID' });
    const stalled = await service(() => {}); const start = Date.now();
    await expect(getExpertREnvironment({ ...stalled, timeoutMs: 50 })).rejects.toMatchObject({ code: 'R_ENVIRONMENT_UNAVAILABLE' });
    expect(Date.now()-start).toBeLessThan(1000);
  });
  it('requires a consistent immutable environment in small readiness responses', async () => {
    const fixture = environmentFixture(); let ref = fixture.reference;
    const config = await service((_req,res) => res.end(JSON.stringify({ status:'ok',profileId:fixture.manifest.profileId,sandboxImageDigest:fixture.reference.imageDigest,resourcePolicyVersion:EXPERT_R_RESOURCE_POLICY_VERSION,environment:ref })));
    const variables = { APP_DEPLOYMENT_MODE:'private',EXPERT_R_ENABLED:'true',EXPERT_R_SANDBOX_URL:config.baseUrl,EXPERT_R_SANDBOX_TOKEN:config.token };
    expect((await probeExpertRRuntime(variables)).environment).toEqual(ref);
    ref = undefined; expect((await probeExpertRRuntime(variables)).state).toBe('incompatible');
    ref = environmentFixture('b').reference; expect((await probeExpertRRuntime(variables)).state).toBe('incompatible');
  });
  it('maps an abruptly truncated actual HTTP stream to safe runtime-unavailable recovery',async()=>{
    const config=await service((_req,res)=>{
      res.writeHead(200,{'Content-Type':'application/json','Content-Length':'4096'});
      res.write('{"schema":');setTimeout(()=>res.destroy(),20);
    });
    await expect(getExpertREnvironment(config)).rejects.toMatchObject({code:'R_ENVIRONMENT_UNAVAILABLE',publicSafeHandlerError:true,message:'The exact R environment is unavailable.'});
  });
  it('verifies actual stored manifest bytes, checksum and reference before publication', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(),'traceomics-r-env-')); directories.push(directory);
    const provider = require('./storage').createLocalStorageProvider({ root: directory });
    const { manifest, reference } = environmentFixture(); const key = 'projects/proj_abcdef/artifacts/job_abcdef/environment.json';
    const bytes = env.environmentBytes(env.validateEnvironmentManifest(manifest)); await writeFile(provider.prepareWrite(key),bytes);
    const descriptor = { internalStorageKey:key,checksumSha256:reference.manifestSha256,sizeBytes:bytes.length };
    expect(await env.readEnvironmentArtifact(provider,descriptor,reference)).toEqual(env.validateEnvironmentManifest(manifest));
    await writeFile(provider.resolveKey(key), Buffer.from('changed'));
    await expect(env.readEnvironmentArtifact(provider,descriptor,reference)).rejects.toThrow();
    await expect(env.readEnvironmentArtifact(provider,{ ...descriptor,sizeBytes:env.MAX_ENVIRONMENT_BYTES+1 },reference)).rejects.toMatchObject({ code:'R_ENVIRONMENT_INVALID' });
  });
});
