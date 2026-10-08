import React, { useEffect, useRef, useState } from 'react';
import * as api from '../executions/privateKernelApi';
import { listArtifactVersions } from '../artifacts/artifactApi';

const initialCell=()=>({id:crypto.randomUUID(),name:'Cell 1',source:'# Variables persist in this private session.\nn <- 3\nn'});
const activeStatuses=['starting','ready','running','unknown','stopping'];
const date=value=>value?new Date(value).toLocaleString():'Unavailable';
function Output({entry}) {
  const result=entry?.result;
  if(!entry)return null;
  return <section aria-label="R command output" className="space-y-3 rounded border border-border p-3">
    <div className="font-medium">Command {entry.order} · {entry.status}</div>
    <details><summary className="cursor-pointer text-xs">Executed R source and checksum</summary><pre className="whitespace-pre-wrap overflow-auto max-h-64 text-xs pt-2">{entry.source}</pre><div className="text-xs break-all font-mono">SHA-256 {entry.sourceSha256}</div></details>
    {!entry.completionKnown&&<p role="status">Completion is unconfirmed. Refresh session status; this command will not be rerun automatically.</p>}
    {result?.stdout&&<pre aria-label="R stdout" className="overflow-auto whitespace-pre-wrap text-xs max-h-64">{result.stdout}</pre>}
    {result?.warnings?.length>0&&<ul aria-label="R warnings" className="text-sm text-amber-700">{result.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>}
    {result?.error&&<pre role="alert" className="whitespace-pre-wrap text-sm text-red-600">{result.error.message}</pre>}
    {result?.tables?.map((table,index)=><div key={index} className="overflow-auto"><div className="text-sm font-medium">{table.name}{table.truncated?' · bounded preview':''}</div><table className="text-xs w-full"><thead><tr>{table.columns.map(column=><th className="text-left p-2 border-b border-border" key={column}>{column}</th>)}</tr></thead><tbody>{table.rows.map((row,rowIndex)=><tr key={rowIndex}>{row.map((value,column)=><td className="p-2 border-b border-border" key={column}>{value==null?'NA':String(value)}</td>)}</tr>)}</tbody></table></div>)}
    {result?.figures?.filter(figure=>figure.mimeType==='image/png'&&typeof figure.data==='string'&&/^[A-Za-z0-9+/=]+$/.test(figure.data)).map((figure,index)=><figure key={index}><img alt={`R figure ${index+1}`} src={`data:image/png;base64,${figure.data}`} className="max-w-full max-h-96 object-contain bg-white"/><figcaption className="text-xs break-all">PNG SHA-256 {figure.sha256}</figcaption></figure>)}
    {result?.truncated&&<p className="text-xs text-textMuted">Output was bounded by the console preview limits.</p>}
  </section>;
}
export default function RConsole({projectId,userId,workspaceId,objects=[],preferredObjectId='',deploymentPolicy={}}) {
  const [cells,setCells]=useState(()=>[initialCell()]); const [cellIndex,setCellIndex]=useState(0); const [selection,setSelection]=useState({start:0,end:0});
  const [session,setSession]=useState(null); const [journal,setJournal]=useState([]); const [entry,setEntry]=useState(null);
  const [versions,setVersions]=useState([]); const [selectedInputs,setSelectedInputs]=useState([]); const [objectId,setObjectId]=useState('');
  const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [uncertain,setUncertain]=useState(false); const [confirmStop,setConfirmStop]=useState(false);
  const requestEpoch=useRef(0); const editor=useRef(null); const startRequest=useRef(null);
  const environment=deploymentPolicy.expertREnvironment||deploymentPolicy.expertRStatus?.runtime?.environment;
  const supported=deploymentPolicy.expertREnabled===true&&(deploymentPolicy.persistentKernel===true||deploymentPolicy.expertRStatus?.runtime?.persistentKernel===true);
  const enabled=Boolean(projectId&&userId&&workspaceId&&supported&&!deploymentPolicy.demoMode);
  const current=cells[cellIndex]||cells[0];
  const currentScope=useRef(''); const scopeKey=`${projectId}:${userId}:${workspaceId}`; currentScope.current=scopeKey;
  const active=session&&activeStatuses.includes(session.status);
  function clearPrivate(){setSession(null);setJournal([]);setEntry(null);setSelectedInputs([]);setVersions([]);setUncertain(false);}
  async function runRequest(action) {
    const epoch=requestEpoch.current; const scope=scopeKey; setBusy(true);setError('');
    try {const result=await action();if(epoch===requestEpoch.current&&scope===currentScope.current)return result;}
    catch(failure){if(epoch===requestEpoch.current&&scope===currentScope.current){setError(failure.message);if([403,404].includes(failure.status))clearPrivate();if(['PRIVATE_KERNEL_TRANSPORT_UNKNOWN','PRIVATE_KERNEL_RESPONSE_INVALID'].includes(failure.code))setUncertain(true);}}
    finally{if(epoch===requestEpoch.current&&scope===currentScope.current)setBusy(false);}
  }
  async function refreshJournal(kernel) {
    const value=await api.listPrivateRExecutions(projectId,kernel.id); return value.items;
  }
  async function refresh() {
    const value=await runRequest(async()=>{const kernel=session?await api.getPrivateRKernel(projectId,session.id):(await api.listPrivateRKernels(projectId,{workspaceId})).items[0]||null;return {kernel,entries:kernel?await refreshJournal(kernel):[]};});
    if(!value)return;setSession(value.kernel);setJournal(value.entries);setUncertain(value.kernel?.status==='unknown');
    if(entry&&value.kernel){const detail=await runRequest(()=>api.getPrivateRExecution(projectId,value.kernel.id,entry.id));if(detail)setEntry(detail);}
  }
  useEffect(()=>{
    requestEpoch.current+=1;clearPrivate();setCells([initialCell()]);setCellIndex(0);setSelection({start:0,end:0});setObjectId('');setError('');setBusy(false);setConfirmStop(false);startRequest.current=null;
    if(!enabled)return undefined;
    let disposed=false;
    Promise.all([api.listPrivateRKernels(projectId,{workspaceId}),listArtifactVersions(projectId)]).then(([kernels,artifacts])=>{if(disposed)return;setSession(kernels.items[0]||null);setVersions(artifacts.items);}).catch(failure=>{if(!disposed)setError(failure.message);});
    return()=>{disposed=true;requestEpoch.current+=1;};
  },[projectId,userId,workspaceId,enabled]);
  const start=async()=>{
    const input={requestId:startRequest.current||crypto.randomUUID(),workspaceId,analysisObjectId:objectId||null,environment,inputs:versions.filter(version=>selectedInputs.includes(version.versionId)).map(version=>version.reference)};startRequest.current=input.requestId;
    const value=await runRequest(()=>api.startPrivateRKernel(projectId,input));if(value){setSession(value);setEntry(null);setJournal([]);setUncertain(value.status==='unknown');startRequest.current=null;}
  };
  const execute=async selected=>{
    const source=selected?current.source.slice(selection.start,selection.end):current.source;
    const value=await runRequest(()=>api.executePrivateRKernel(projectId,session.id,{requestId:crypto.randomUUID(),source}));
    if(value){setEntry(value);setUncertain(!value.completionKnown);const refreshed=await runRequest(async()=>({kernel:await api.getPrivateRKernel(projectId,session.id),entries:await refreshJournal(session)}));if(refreshed){setSession(refreshed.kernel);setJournal(refreshed.entries);}}
  };
  const stop=async()=>{const value=await runRequest(()=>api.stopPrivateRKernel(projectId,session.id));if(value){setSession(value);setConfirmStop(false);setUncertain(value.status==='unknown');startRequest.current=null;}};
  const openEntry=async item=>{const value=await runRequest(()=>api.getPrivateRExecution(projectId,session.id,item.id));if(value)setEntry(value);};
  const edit=value=>{setCells(items=>items.map((cell,index)=>index===cellIndex?{...cell,source:value}:cell));setSelection({start:0,end:0});};
  return <section aria-label="Private R console" className="rounded-xl border border-border bg-surface text-text p-4 space-y-4">
    <div><h2 className="text-lg font-semibold">Private R console</h2><p className="text-sm text-textMuted">Run free R cells or selected source. Variables persist inside your isolated session; stopping discards unsaved memory and files.</p></div>
    {!enabled&&<p role="status">{deploymentPolicy.demoMode?'Private R sessions are unavailable in the public demo.':!projectId?'Choose a project to use the console.':'Persistent R sessions require execution access and a runtime with private kernel support. Existing one-shot R remains available in supported deployments.'}</p>}
    {error&&<div role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    {uncertain&&<p role="status" className="rounded border border-amber-300 p-3 text-sm">Completion or memory availability is unknown. Refresh status to inspect the retained command. No analysis will be rerun automatically.</p>}
    {enabled&&<>
      <div className="flex flex-wrap items-center gap-3">
        {!active&&<><label className="text-sm">Initial saved analysis<select aria-label="Initial saved analysis" value={objectId} onChange={event=>{setObjectId(event.target.value);startRequest.current=null;}} disabled={busy} className="block border border-border rounded p-2 bg-surface text-text"><option value="">Empty R session</option>{objects.map(object=><option key={object.id} value={object.id}>{object.displayName||object.name||object.id}{object.id===preferredObjectId?' · current':''}</option>)}</select></label><button className="btn btn-primary" disabled={busy||!environment} onClick={start}>Start private session</button></>}
        <button className="btn btn-secondary" disabled={busy} onClick={refresh}>Refresh session status</button>
        {active&&!confirmStop&&<button className="btn btn-secondary" disabled={busy} onClick={()=>setConfirmStop(true)}>Stop session</button>}
        {confirmStop&&<><span className="text-sm">Unsaved variables and files will be lost.</span><button className="btn btn-secondary" disabled={busy} onClick={stop}>Stop and discard unsaved memory</button><button className="btn btn-secondary" disabled={busy} onClick={()=>setConfirmStop(false)}>Keep session</button></>}
      </div>
      {!active&&versions.length>0&&<fieldset className="rounded border border-border p-3 space-y-2"><legend className="text-sm">Verified input versions · select up to five</legend>{versions.map(version=><label key={version.versionId} className="flex gap-2 text-xs items-start"><input type="checkbox" aria-label={`Use ${version.name}`} checked={selectedInputs.includes(version.versionId)} disabled={busy||selectedInputs.length>=5&&!selectedInputs.includes(version.versionId)} onChange={event=>{setSelectedInputs(items=>event.target.checked?[...items,version.versionId]:items.filter(value=>value!==version.versionId));startRequest.current=null;}}/><span>{version.name} · {version.format.id}<span className="block font-mono break-all">{version.sha256}</span></span></label>)}</fieldset>}
      {session&&<div aria-label="R session identity" className="rounded border border-border p-3 text-xs space-y-2"><div className="font-medium">Session {session.status} · unsaved memory {session.memoryState}</div><div>R {session.environment.rVersion} · {session.resources.cpuLimit||'?'} CPUs · {session.resources.memoryBytes?Math.round(session.resources.memoryBytes/1024**2):'?'} MiB · idle timeout {session.resources.idleTimeoutSeconds||'?'} seconds</div><details><summary className="cursor-pointer">Session reproducibility details</summary><div className="space-y-1 pt-2"><div className="break-all">Kernel {session.id} · generation {session.generation||'Unconfirmed'}</div><div>Target {session.target?.id||'Unconfirmed'} · starts {date(session.startedAt)} · expires {date(session.expiresAt)}</div><div className="break-all">Environment SHA-256 {session.environment.manifestSha256}</div>{session.inputs.map(input=><div key={input.id}>{input.role}: {input.name} · <span className="break-all font-mono">{input.checksumSha256}</span></div>)}</div></details></div>}
      <div className="flex flex-wrap gap-2">{cells.map((cell,index)=><button className="btn btn-secondary text-xs" aria-pressed={index===cellIndex} key={cell.id} onClick={()=>{setCellIndex(index);setSelection({start:0,end:0});}}>{cell.name}</button>)}<button className="btn btn-secondary text-xs" onClick={()=>{setCells(items=>[...items,{id:crypto.randomUUID(),name:`Cell ${items.length+1}`,source:''}]);setCellIndex(cells.length);setSelection({start:0,end:0});}}>Add R cell</button></div>
      <label className="block text-sm">{current.name} source<textarea ref={editor} aria-label="R console source" className="block w-full min-h-48 rounded border border-border bg-surface text-text p-3 font-mono text-sm" spellCheck={false} value={current.source} onChange={event=>edit(event.target.value)} onSelect={event=>setSelection({start:event.target.selectionStart,end:event.target.selectionEnd})}/></label>
      <div className="flex flex-wrap items-center gap-2"><button className="btn btn-primary" disabled={busy||session?.status!=='ready'||uncertain||!current.source.trim()} onClick={()=>execute(false)}>Run R cell</button><button className="btn btn-secondary" disabled={busy||session?.status!=='ready'||uncertain||selection.start===selection.end} onClick={()=>execute(true)}>Run selected R</button><span className="text-xs text-textMuted">32 KiB source limit · ordered creator-private journal · bounded table/PNG previews</span></div>
      <Output entry={entry}/>
      {journal.length>0&&<div aria-label="R command journal" className="space-y-2"><h3 className="text-sm font-medium">Retained source and command order</h3><div className="flex flex-wrap gap-2">{journal.map(item=><button className="btn btn-secondary text-xs" key={item.id} onClick={()=>openEntry(item)} disabled={busy}>Command {item.order} · {item.status}</button>)}</div></div>}
      <p className="text-xs text-textMuted">Source, order, environment, and bounded console previews are retained privately. Variables and files remain unsaved; console previews are not published scientific artifact versions. Untracked intermediate state leaves replay evidence incomplete.</p>
    </>}
  </section>;
}
