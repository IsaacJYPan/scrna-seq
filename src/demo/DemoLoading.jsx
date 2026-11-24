import React from 'react';
import { ArrowRight, Dna, Loader2, Microscope } from 'lucide-react';
import './demo.css';
import { APP_NAME } from '../brand';

export function DemoBrand() {
  return <div className="demo-brand"><Dna size={23} /><span>{APP_NAME}</span><span className="demo-badge">Demo</span></div>;
}

export default function DemoLoading({ error, onRetry, message = 'Loading counts and QC metrics…' }) {
  return <div className="demo-shell demo-loading"><DemoBrand /><main>
    {error ? <><h1>Unable to load analysis</h1><p role="alert">{error}</p><button className="demo-primary" onClick={onRetry}>Retry <ArrowRight size={16} /></button></>
      : <><Loader2 className="demo-spin" size={26} /><h1>Loading PBMC3k</h1><p role="status">{message}</p></>}
  </main></div>;
}

// Neutral loading screen while the deployment's mode is still unknown, and for
// the regular workbench: a signed-in researcher should never see a demo badge
// or a dataset name they did not choose.
export function AppLoading({ error, onRetry, message = 'Opening the workbench…' }) {
  return <div className="flex min-h-dvh items-center justify-center bg-background p-6 text-text">
    <div className="w-full max-w-sm text-center">
      <div className="nav-rail-mark mx-auto mb-4 flex h-10 w-10 items-center justify-center"><Microscope size={20} aria-hidden="true" /></div>
      <p className="login-wordmark text-lg font-semibold">{APP_NAME}</p>
      {error ? <><p role="alert" className="mt-4 text-sm text-danger">{error}</p>
        <button className="btn btn-primary mt-3" onClick={onRetry}>Retry</button></>
        : <p role="status" className="mt-4 flex items-center justify-center gap-2 text-sm text-textMuted"><Loader2 size={18} className="animate-spin" aria-hidden="true" />{message}</p>}
    </div>
  </div>;
}
