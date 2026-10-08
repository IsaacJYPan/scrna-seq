import React from 'react';
import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import REnvironment from './REnvironment';
const { environmentFixture }=require('../../backend/_r-environment-test-utils');
const { manifest,reference }=environmentFixture();
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('TextEncoder',TextEncoder);window.electronAPI={getExpertREnvironment:vi.fn(async()=>manifest)};});
afterEach(()=>{delete window.electronAPI;vi.unstubAllGlobals();});
describe('exact R environment UI',()=>{
  it('shows immutable scope and verified package versions and origins',async()=>{
    render(<REnvironment reference={reference} projectId="proj_test"/>);
    expect(screen.getByText(/R 4.5.3 · Bioconductor 3.22/)).toBeInTheDocument();
    expect(screen.getByText(/host kernel and hardware are outside/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Inspect package lock'}));
    expect(await screen.findByRole('button',{name:'Download environment manifest'})).toBeEnabled();
    expect(screen.getByText('5.3.0')).toBeInTheDocument();expect(screen.getByText('CRAN')).toBeInTheDocument();
    expect(window.electronAPI.getExpertREnvironment).toHaveBeenCalledWith('proj_test');
  });
  it('blocks a changed manifest and provides recovery without rendering service diagnostics',async()=>{
    const changed=structuredClone(manifest);changed.packages[1].version='5.4.0';window.electronAPI.getExpertREnvironment.mockResolvedValueOnce(changed);
    render(<REnvironment reference={reference} projectId="proj_test"/>);fireEvent.click(screen.getByRole('button',{name:'Inspect package lock'}));
    expect(await screen.findByRole('alert')).toHaveTextContent(/exact environment could not be verified/);expect(screen.queryByRole('button',{name:'Download environment manifest'})).not.toBeInTheDocument();
  });
  it('discards stale private inspection when the selected project changes',async()=>{
    let resolve;window.electronAPI.getExpertREnvironment.mockReturnValueOnce(new Promise(value=>{resolve=value;}));
    const { rerender }=render(<REnvironment reference={reference} projectId="proj_first"/>);fireEvent.click(screen.getByRole('button',{name:'Inspect package lock'}));
    rerender(<REnvironment reference={reference} projectId="proj_second"/>);resolve(manifest);
    await waitFor(()=>expect(screen.getByRole('button',{name:'Inspect package lock'})).toBeEnabled());
    expect(screen.queryByRole('button',{name:'Download environment manifest'})).not.toBeInTheDocument();
  });
});
