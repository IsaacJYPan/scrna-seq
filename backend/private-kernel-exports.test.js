import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const { generatePrivateKernelExportSource, exportFilename, validatePrivateKernelExportRequest,
  extractPrivateKernelFile, MAX_PRIVATE_KERNEL_EXPORT_BYTES } = require('./privateKernelExports');
const directories=[];
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
const generation='a'.repeat(64), publicationId=`pub_${'b'.repeat(24)}`;
const spec={publicationId,generation,type:'table',binding:'full table ` α'};
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
async function setup(){const directory=await mkdtemp(path.join(os.tmpdir(),'private-export-'));directories.push(directory);return path.join(directory,'output');}
function childFor(chunks,{code=0,error=false,onSpawn,hang=false}={}) {
  return (...args)=>{
    onSpawn?.(args);
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;
    child.kill=()=>{child.killed=true;child.stdout.destroy();setImmediate(()=>child.emit('close',1));};
    setImmediate(()=>{if(error){child.emit('error',new Error('sensitive host diagnostics'));return;}if(hang)return;
      for(const chunk of chunks)child.stdout.write(chunk);child.stdout.end();setImmediate(()=>child.emit('close',code));});
    return child;
  };
}
describe('private R publication source and identity',()=>{
  it('produces one exact bounded serialization command for the existing global binding',()=>{
    const source=generatePrivateKernelExportSource(spec);
    expect(source).toContain('base::get("full table ` α", envir = base::globalenv(), inherits = FALSE)');
    expect(source).toContain('utils::write.csv');expect(source).toContain('row.names = FALSE');
    expect(source).toContain('20 MiB');expect(exportFilename(spec)).toMatch(/^[a-f0-9]{64}\.csv$/);
    expect(generatePrivateKernelExportSource({...spec,type:'object'})).toContain('base::saveRDS');
    expect(exportFilename({...spec,generation:'c'.repeat(64)})).not.toBe(exportFilename(spec));
    const result=validatePrivateKernelExportRequest({...spec,source,executionId:'pex_1',order:2,internalStorageKey:'projects/project1/artifacts/av_1/content.csv'},
      {projectId:'project1',generation});expect(result.filename).toBe(exportFilename(spec));
  });
  it('rejects altered generated source, cross-project storage and malformed publication identity',()=>{
    const valid={...spec,source:generatePrivateKernelExportSource(spec),internalStorageKey:'projects/project1/artifacts/av_1/content.csv'};
    for(const altered of [{publicationId:'../../output'},{binding:'a\nstop(1)'},{binding:'α'.repeat(129)},{type:'figure'},{source:valid.source+';system("x")'},
      {internalStorageKey:'projects/project2/artifacts/av_1/content.csv'}])expect(()=>validatePrivateKernelExportRequest({...valid,...altered},{projectId:'project1',generation})).toThrow();
  });
  it('binds a large streamed reservation to the exact FIFO source and filename without R integer overflow',()=>{
    const streamed={...spec,stream:true,maxBytes:3*1024**3};
    const source=generatePrivateKernelExportSource(streamed);
    expect(source).toContain('reserved_bytes <- 3221225472');expect(source).not.toContain('3221225472L');
    expect(source).toContain('base::fifo');expect(source).toContain('base::on.exit(base::close(connection)');
    expect(source).not.toContain('file.info');expect(exportFilename(streamed)).not.toBe(exportFilename(spec));
    expect(exportFilename({...streamed,maxBytes:streamed.maxBytes-1})).not.toBe(exportFilename(streamed));
    const object=generatePrivateKernelExportSource({...streamed,type:'object'});expect(object).toContain('compress = FALSE');
    for(const change of [{maxBytes:0},{maxBytes:64*1024**3+1},{stream:false},{stream:undefined}])expect(()=>generatePrivateKernelExportSource({...streamed,...change})).toThrow();
    const request={...streamed,source,internalStorageKey:'projects/project1/artifacts/av_1/content.csv'};
    expect(validatePrivateKernelExportRequest(request,{projectId:'project1',generation})).toMatchObject({stream:true,maxBytes:3*1024**3});
    expect(()=>validatePrivateKernelExportRequest({...request,maxBytes:request.maxBytes-1},{projectId:'project1',generation})).toThrow();
  });
});
describe('one-file isolated descriptor extraction',()=>{
  const bytes=Buffer.from('cell,count\na,2\nb,3\n');
  const expected={checksumSha256:digest(bytes),sizeBytes:bytes.length};
  const filename=exportFilename(spec),containerId='d'.repeat(64);
  it('streams actual bytes through a fixed descriptor reader and verifies their hash',async()=>{
    const destination=await setup();let args;
    const output=await extractPrivateKernelFile({containerId,filename,destination,expected,
      spawnImpl:childFor([bytes.subarray(0,4),bytes.subarray(4)],{onSpawn:value=>args=value})});
    expect(output).toEqual({filePath:destination,...expected});expect(await readFile(destination)).toEqual(bytes);
    expect(args[1].slice(0,4)).toEqual(['exec','--user','10001:10001',containerId]);
    expect(args[1]).toContain(filename);expect(args[1][6]).toContain('os.O_NOFOLLOW');expect(args[1][6]).toContain('stat.S_ISREG');
    expect(args[1].join(' ')).not.toContain('tar');expect(args[2]).toMatchObject({windowsHide:true});
  });
  it('rejects invalid evidence and paths before launching any process',async()=>{
    const destination=await setup();let launches=0;
    for(const change of [{filename:'../content.csv'},{filename:filename+'.extra'},{containerId:'container-alias'},
      {expected:{...expected,sizeBytes:MAX_PRIVATE_KERNEL_EXPORT_BYTES+1}},{expected:{...expected,checksumSha256:'invalid'}}]) {
      await expect(extractPrivateKernelFile({containerId,filename,destination,expected,...change,spawnImpl:()=>{launches++;}})).rejects.toMatchObject({code:'PRIVATE_KERNEL_PUBLICATION_INVALID'});
    }
    expect(launches).toBe(0);
  });
  it('rejects truncated, altered and excessive bytes and removes its own partial output',async()=>{
    for(const chunks of [[bytes.subarray(1)],[Buffer.from('x'.repeat(bytes.length))],[bytes,Buffer.from('x')]]) {
      const destination=await setup();await expect(extractPrivateKernelFile({containerId,filename,destination,expected,spawnImpl:childFor(chunks)})).rejects.toMatchObject({code:'PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE'});
      await expect(readFile(destination)).rejects.toMatchObject({code:'ENOENT'});
    }
  });
  it('does not overwrite or clean up a preexisting broker destination',async()=>{
    const destination=await setup();await writeFile(destination,'existing');let launches=0;
    await expect(extractPrivateKernelFile({containerId,filename,destination,expected,spawnImpl:()=>{launches++;}})).rejects.toMatchObject({code:'EEXIST'});
    expect(launches).toBe(0);expect(await readFile(destination,'utf8')).toBe('existing');
  });
  it('bounds transfer lifetime, handles cancellation and hides process diagnostics',async()=>{
    for(const options of [{spawnImpl:childFor([],{hang:true}),timeoutMs:10},{spawnImpl:childFor([],{error:true})},{spawnImpl:childFor([bytes],{code:1})}]) {
      const destination=await setup();await expect(extractPrivateKernelFile({containerId,filename,destination,expected,...options})).rejects.toMatchObject({code:'PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE'});
      await expect(readFile(destination)).rejects.toMatchObject({code:'ENOENT'});
    }
    const controller=new AbortController(),destination=await setup();const result=extractPrivateKernelFile({containerId,filename,destination,expected,spawnImpl:childFor([],{hang:true}),signal:controller.signal});
    setTimeout(()=>controller.abort(),10);await expect(result).rejects.toMatchObject({code:'PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE'});await expect(readFile(destination)).rejects.toMatchObject({code:'ENOENT'});
  });
});
