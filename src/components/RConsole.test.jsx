import React from 'react';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import RConsole from './RConsole';
import * as api from '../executions/privateKernelApi';
import {listArtifactVersions} from '../artifacts/artifactApi';
vi.mock('../executions/privateKernelApi',()=>({listPrivateRKernels:vi.fn(),startPrivateRKernel:vi.fn(),getPrivateRKernel:vi.fn(),executePrivateRKernel:vi.fn(),listPrivateRExecutions:vi.fn(),getPrivateRExecution:vi.fn(),stopPrivateRKernel:vi.fn()}));
vi.mock('../artifacts/artifactApi',()=>({listArtifactVersions:vi.fn()}));
const environment={rVersion:'4.5.3',manifestSha256:'a'.repeat(64)};
const kernel={id:'pk_one',status:'ready',generation:'b'.repeat(64),environment,inputs:[],resources:{cpuLimit:1,memoryBytes:1024**3,idleTimeoutSeconds:900},target:{id:'private-r-kernel'},memoryState:'available'};
const entry={id:'pex_one',order:1,status:'completed',source:'n <- 3',sourceSha256:'c'.repeat(64),completionKnown:true,result:{stdout:'[1] 3\n',warnings:['R warning'],error:null,tables:[{name:'Cells',columns:['count','condition'],rows:[[3,'<script>inert</script>']]}],figures:[{mimeType:'image/png',data:'YWJj',sha256:'d'.repeat(64)}]}};
const props={projectId:'project_one',userId:1,workspaceId:'workspace_one',deploymentPolicy:{expertREnabled:true,persistentKernel:true,expertREnvironment:environment},objects:[]};
beforeEach(()=>{vi.resetAllMocks();api.listPrivateRKernels.mockResolvedValue({items:[]});api.startPrivateRKernel.mockResolvedValue(kernel);api.getPrivateRKernel.mockResolvedValue(kernel);api.executePrivateRKernel.mockResolvedValue(entry);api.listPrivateRExecutions.mockResolvedValue({items:[entry]});api.getPrivateRExecution.mockResolvedValue(entry);api.stopPrivateRKernel.mockResolvedValue({...kernel,status:'stopped',memoryState:'lost'});listArtifactVersions.mockResolvedValue({items:[]});});
async function start(){await waitFor(()=>expect(api.listPrivateRKernels).toHaveBeenCalled());fireEvent.click(screen.getByRole('button',{name:'Start private session'}));await screen.findByText('Session ready · unsaved memory available');}
it('starts empty R with exact environment and no pipeline and renders bounded inert source/output/table/PNG',async()=>{
  render(<RConsole {...props}/>);await start();expect(api.startPrivateRKernel).toHaveBeenCalledWith('project_one',expect.objectContaining({workspaceId:'workspace_one',analysisObjectId:null,environment,inputs:[],requestId:expect.any(String)}));
  fireEvent.change(screen.getByLabelText('R console source'),{target:{value:'n <- 3'}});fireEvent.click(screen.getByRole('button',{name:'Run R cell'}));await screen.findByRole('cell',{name:'<script>inert</script>'});expect(document.querySelector('script')).toBeNull();expect(screen.getByLabelText('R stdout')).toHaveTextContent('[1] 3');expect(screen.getByRole('img',{name:'R figure 1'})).toHaveAttribute('src','data:image/png;base64,YWJj');expect(screen.getByText(/not published scientific artifact versions/)).toBeVisible();
});
it('runs only selected source and supports independent editable cells',async()=>{
  render(<RConsole {...props}/>);await start();const editor=screen.getByLabelText('R console source');fireEvent.change(editor,{target:{value:'n <- 3\nn + 1'}});editor.setSelectionRange(7,12);fireEvent.select(editor);fireEvent.click(screen.getByRole('button',{name:'Run selected R'}));await waitFor(()=>expect(api.executePrivateRKernel).toHaveBeenCalledWith('project_one','pk_one',expect.objectContaining({source:'n + 1'})));
  fireEvent.click(screen.getByRole('button',{name:'Add R cell'}));expect(editor).toHaveValue('');fireEvent.change(editor,{target:{value:'summary(n)'}});fireEvent.click(screen.getByRole('button',{name:'Cell 1',exact:true}));expect(editor).toHaveValue('n <- 3\nn + 1');
});
it('sends exact selected input refs and displays researcher-friendly saved analysis names',async()=>{
  const version={versionId:'av_one',name:'Samples',format:{id:'org.ietf.csv'},sha256:'e'.repeat(64),reference:{artifactId:'af_one',versionId:'av_one',projectId:'project_one',sha256:'e'.repeat(64)}};listArtifactVersions.mockResolvedValue({items:[version]});render(<RConsole {...props} objects={[{id:'ao_one',displayName:'Saved treated cells'}]}/>);fireEvent.click(await screen.findByLabelText('Use Samples'));fireEvent.change(screen.getByLabelText('Initial saved analysis'),{target:{value:'ao_one'}});await start();expect(api.startPrivateRKernel.mock.calls[0][1]).toMatchObject({analysisObjectId:'ao_one',inputs:[version.reference]});
});
it('never reruns an uncertain command and permits only status inspection or explicit memory loss',async()=>{
  api.executePrivateRKernel.mockRejectedValueOnce(Object.assign(new Error('Connection ended. Inspect completion.'),{code:'PRIVATE_KERNEL_TRANSPORT_UNKNOWN'}));render(<RConsole {...props}/>);await start();fireEvent.click(screen.getByRole('button',{name:'Run R cell'}));await screen.findByRole('alert');expect(screen.getByRole('button',{name:'Run R cell'})).toBeDisabled();expect(api.executePrivateRKernel).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Refresh session status'}));await waitFor(()=>expect(api.getPrivateRKernel).toHaveBeenCalled());expect(api.executePrivateRKernel).toHaveBeenCalledTimes(1);fireEvent.click(screen.getByRole('button',{name:'Stop session'}));expect(api.stopPrivateRKernel).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Stop and discard unsaved memory'}));await screen.findByText('Session stopped · unsaved memory lost');expect(api.stopPrivateRKernel).toHaveBeenCalledTimes(1);
});
it('clears private results after access revocation without retaining previous table or source journal',async()=>{
  render(<RConsole {...props}/>);await start();fireEvent.click(screen.getByRole('button',{name:'Run R cell'}));await screen.findByRole('table');api.getPrivateRKernel.mockRejectedValueOnce(Object.assign(new Error('Private R access revoked.'),{status:403}));fireEvent.click(screen.getByRole('button',{name:'Refresh session status'}));await screen.findByRole('alert');expect(screen.queryByRole('table')).not.toBeInTheDocument();expect(screen.queryByLabelText('R command journal')).not.toBeInTheDocument();
});
it('discards late command responses after changing project or user, without submitting source again',async()=>{
  let finish;api.executePrivateRKernel.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const view=render(<RConsole {...props}/>);await start();fireEvent.click(screen.getByRole('button',{name:'Run R cell'}));view.rerender(<RConsole {...props} projectId="project_two" userId={2}/>);await act(async()=>finish(entry));expect(screen.queryByRole('table')).not.toBeInTheDocument();expect(screen.queryByText('Command 1 · completed')).not.toBeInTheDocument();expect(api.executePrivateRKernel).toHaveBeenCalledTimes(1);
});
it('keeps unsupported old runtimes and demo deployments explicit without probing or starting kernels',()=>{
  render(<RConsole {...props} deploymentPolicy={{expertREnabled:true,expertREnvironment:environment}}/>);expect(screen.getByRole('status')).toHaveTextContent('private kernel support');expect(api.listPrivateRKernels).not.toHaveBeenCalled();expect(api.startPrivateRKernel).not.toHaveBeenCalled();
});
