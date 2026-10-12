import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as api from './privateKernelApi';
vi.mock('../api',()=>({apiUrl:value=>value}));
beforeEach(()=>vi.stubGlobal('fetch',vi.fn()));afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('uses cookie authentication/CSRF and exact encoded session/command routes without scientific retries',async()=>{fetch.mockResolvedValue({ok:true,json:async()=>({id:'kernel'})});await api.startPrivateRKernel('project one',{requestId:'request',source:'n <- 3'});expect(fetch).toHaveBeenCalledWith('/api/private-r-kernels/project%20one',expect.objectContaining({method:'POST',credentials:'include',headers:{'X-Traceomics-Csrf':'1','Content-Type':'application/json'}}));await api.getPrivateRExecution('project','kernel 1','execution 1');expect(fetch.mock.lastCall[0]).toBe('/api/private-r-kernels/project/kernel%201/executions/execution%201');});
it('marks network or malformed replies unconfirmed without exposing endpoint URLs or response HTML',async()=>{fetch.mockRejectedValueOnce(new Error('https://private-host/token'));await expect(api.executePrivateRKernel('project','kernel',{source:'n'})).rejects.toMatchObject({code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});expect(fetch).toHaveBeenCalledTimes(1);fetch.mockResolvedValueOnce({ok:true,json:async()=>{throw new SyntaxError('<html>secret');}});await expect(api.getPrivateRKernel('project','kernel')).rejects.toMatchObject({code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});});
it('preserves bounded access errors and cancellation semantics',async()=>{fetch.mockResolvedValueOnce({ok:false,status:403,json:async()=>({error:'Private R access required.',code:'EXPERT_R_ACCESS_REQUIRED'})});await expect(api.listPrivateRKernels('project')).rejects.toMatchObject({status:403,code:'EXPERT_R_ACCESS_REQUIRED'});const aborted=new DOMException('Aborted','AbortError');fetch.mockRejectedValueOnce(aborted);await expect(api.getPrivateRKernel('project','kernel')).rejects.toBe(aborted);});
it.each([401,403])('preserves non-JSON HTTP %s access loss without exposing response HTML',async status=>{
  fetch.mockResolvedValueOnce({ok:false,status,json:async()=>{throw new SyntaxError('<html>private login page</html>');}});
  const failure=await api.getPrivateRKernel('project','kernel').catch(error=>error);
  expect(failure).toMatchObject({status,code:'PRIVATE_KERNEL_ACCESS_REQUIRED'});
  expect(failure.message).not.toMatch(/html|private login page/);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('reads authenticated installation identity without submitting work',async()=>{
  const identity={schema:'traceomics.installation.v1',installationId:'svc_'+'a'.repeat(32),userId:7};
  fetch.mockResolvedValueOnce({ok:true,json:async()=>identity});
  await expect(api.getPrivateRIdentity()).resolves.toEqual(identity);
  expect(fetch).toHaveBeenLastCalledWith('/api/auth/installation',expect.objectContaining({method:'GET',credentials:'include'}));
});
it('retains HTTP error status when an upstream error body is malformed',async()=>{
  fetch.mockResolvedValueOnce({ok:false,status:503,json:async()=>{throw new SyntaxError('upstream HTML');}});
  await expect(api.getPrivateRKernel('project','kernel')).rejects.toMatchObject({status:503,code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});
});
it('publishes only an explicit binding or exact figure reference through cookie/CSRF authenticated bounded routes',async()=>{
  fetch.mockResolvedValue({ok:true,json:async()=>({publication:{id:'pub_one',status:'completed'},version:{versionId:'av_one'}})});
  const controller=new AbortController();const input={requestId:'same-request',type:'object',binding:'cells with spaces',name:'Control cells',previousVersionId:'av_prior'};
  await api.publishPrivateROutput('project one','kernel one',input,controller.signal);
  expect(fetch).toHaveBeenCalledWith('/api/private-r-kernels/project%20one/kernel%20one/publications',expect.objectContaining({method:'POST',credentials:'include',signal:controller.signal,headers:{'X-Traceomics-Csrf':'1','Content-Type':'application/json'},body:JSON.stringify(input)}));
  await api.publishPrivateROutput('project','kernel',{requestId:'figure-request',type:'figure',name:'Condition plot',executionId:'pex_exact',figureIndex:2});
  expect(JSON.parse(fetch.mock.lastCall[1].body)).toEqual({requestId:'figure-request',type:'figure',name:'Condition plot',executionId:'pex_exact',figureIndex:2});
});
it('refreshes publication receipts without a new export and never retries an unknown publication',async()=>{
  fetch.mockRejectedValueOnce(new Error('Private export socket disconnected.'));
  await expect(api.publishPrivateROutput('project','kernel',{requestId:'request',type:'table',binding:'counts',name:'Counts'})).rejects.toMatchObject({code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});
  expect(fetch).toHaveBeenCalledTimes(1);fetch.mockResolvedValueOnce({ok:true,json:async()=>({items:[]})});await api.listPrivateRPublications('project','kernel',{limit:12,before:'pub previous'});
  expect(fetch.mock.lastCall[0]).toBe('/api/private-r-kernels/project/kernel/publications?limit=12&before=pub+previous');expect(fetch.mock.lastCall[1].method).toBe('GET');expect(fetch).toHaveBeenCalledTimes(2);
});
it('binds explicit interrupt and restart requests to their encoded kernel and exact generation without transport retries',async()=>{
  fetch.mockResolvedValue({ok:true,json:async()=>({outcome:'interrupted',idleConfirmed:true})});const signal=new AbortController().signal;
  const input={requestId:'control-request',generation:'a'.repeat(64),executionRequestId:'pending-source-request'};await api.interruptPrivateRKernel('project one','kernel one',input,signal);
  expect(fetch).toHaveBeenLastCalledWith('/api/private-r-kernels/project%20one/kernel%20one/interrupt',expect.objectContaining({method:'POST',credentials:'include',signal,headers:{'X-Traceomics-Csrf':'1','Content-Type':'application/json'},body:JSON.stringify(input)}));
  const restart={requestId:'retained-restart',generation:'a'.repeat(64)};fetch.mockRejectedValueOnce(new Error('Disconnected restart.'));await expect(api.restartPrivateRKernel('project','kernel',restart)).rejects.toMatchObject({code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockResolvedValueOnce({ok:true,json:async()=>({status:'completed'})});await api.restartPrivateRKernel('project','kernel',restart);expect(fetch).toHaveBeenLastCalledWith('/api/private-r-kernels/project/kernel/restart',expect.objectContaining({method:'POST',body:JSON.stringify(restart)}));expect(fetch).toHaveBeenCalledTimes(3);
  await api.getPrivateRRestart('project one','kernel one',signal);expect(fetch).toHaveBeenLastCalledWith('/api/private-r-kernels/project%20one/kernel%20one/restart',expect.objectContaining({method:'GET',credentials:'include',signal,body:undefined}));
});
it('reads all four exact UUID receipts through encoded GET routes with cookie authentication and no caching',async()=>{
  fetch.mockImplementation(async()=>new Response(JSON.stringify({schema:'traceomics.private-r-submission.v1',requestId:'request one'})));
  await api.getPrivateRStartSubmission('project one','request one');
  await api.getPrivateRExecutionSubmission('project one','kernel one','request one');
  await api.getPrivateRPublicationSubmission('project one','kernel one','request one');
  await api.getPrivateRRestartSubmission('project one','request one');
  expect(fetch.mock.calls.map(call=>call[0])).toEqual(['/api/private-r-kernels/project%20one/start-submissions/request%20one','/api/private-r-kernels/project%20one/kernel%20one/execution-submissions/request%20one','/api/private-r-kernels/project%20one/kernel%20one/publication-submissions/request%20one','/api/private-r-kernels/project%20one/restart-submissions/request%20one']);
  for(const [,options] of fetch.mock.calls)expect(options).toMatchObject({method:'GET',credentials:'include',cache:'no-store',body:undefined});
});
it.each([401,403,404])('preserves receipt HTTP %s without exposing a non-JSON response',async status=>{
  fetch.mockResolvedValueOnce(new Response('<html>private response</html>',{status}));
  const failure=await api.getPrivateRStartSubmission('project','request').catch(error=>error);
  expect(failure.status).toBe(status);expect(failure.message).not.toContain('private response');expect(fetch).toHaveBeenCalledTimes(1);
});
it('cancels oversized streamed receipt metadata before accepting it',async()=>{
  let cancelled=false;const chunk=new TextEncoder().encode('x'.repeat(9000));
  fetch.mockResolvedValueOnce(new Response(new ReadableStream({pull(controller){controller.enqueue(chunk);},cancel(){cancelled=true;}})));
  await expect(api.getPrivateRExecutionSubmission('project','kernel','request')).rejects.toMatchObject({code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});
  expect(cancelled).toBe(true);expect(fetch).toHaveBeenCalledTimes(1);
});
it('bounds receipt checks to ten seconds even when an upstream request ignores cancellation',async()=>{
  vi.useFakeTimers();fetch.mockImplementationOnce(()=>new Promise(()=>{}));
  const result=api.getPrivateRRestartSubmission('project','request').catch(error=>error);
  await vi.advanceTimersByTimeAsync(10000);expect(await result).toMatchObject({code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'});
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);expect(fetch).toHaveBeenCalledTimes(1);
});
