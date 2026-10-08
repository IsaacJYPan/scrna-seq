import { describe,expect,it,vi } from 'vitest';
const { restoreEnvironment } = require('./restore-r-environment');
const { environmentFixture } = require('../backend/_r-environment-test-utils');
describe('restore exact R environment', () => {
  it('verifies the exact inventory on a compatible worker without any installation',async()=>{
    const { manifest,reference }=environmentFixture(); const runDocker=vi.fn(); const discover=vi.fn(async()=>manifest);
    expect((await restoreEnvironment(manifest,{discover,runDocker})).reference).toEqual(reference);
    expect(runDocker).not.toHaveBeenCalled();expect(discover).toHaveBeenCalledWith({EXPERT_R_SANDBOX_IMAGE:manifest.runtime.imageReference});
  });
  it('fails visibly on unavailable dependencies or a changed package, never substitutes current releases',async()=>{
    const { manifest }=environmentFixture();
    await expect(restoreEnvironment(manifest,{discover:async()=>{throw new Error('missing-package');}})).rejects.toThrow(/no substitute packages/);
    const changed=structuredClone(manifest);changed.packages[1].version='5.4.0';
    await expect(restoreEnvironment(manifest,{discover:async()=>changed})).rejects.toMatchObject({code:'R_ENVIRONMENT_MISMATCH'});
  });
  it('pulls only an explicit exact registry digest and never tries to pull a local image ID',async()=>{
    const { manifest }=environmentFixture(); const runDocker=vi.fn(()=>({status:0}));
    await expect(restoreEnvironment(manifest,{pull:true,runDocker})).rejects.toThrow(/docker save\/docker load/);expect(runDocker).not.toHaveBeenCalled();
    manifest.runtime.imageReference=`registry.example.test/lab/r@${manifest.runtime.imageDigest}`;
    await restoreEnvironment(manifest,{pull:true,runDocker,discover:async()=>manifest});
    expect(runDocker).toHaveBeenCalledWith(['pull',manifest.runtime.imageReference]);
  });
});
