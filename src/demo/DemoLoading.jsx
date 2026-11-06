import React from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import TraceMark from '../components/TraceMark';
import './demo.css';

export function DemoBrand() {
  return <div className="demo-brand"><TraceMark size={26} className="text-[#3e3a92]" /><span>TraceOmics</span><span className="demo-badge">Demo</span></div>;
}

export default function DemoLoading({ error, onRetry, message = 'Loading counts and QC metrics…' }) {
  return <div className="demo-shell demo-loading"><DemoBrand /><main>
    {error ? <><h1>Unable to load analysis</h1><p role="alert">{error}</p><button className="demo-primary" onClick={onRetry}>Retry <ArrowRight size={16} /></button></>
      : <><Loader2 className="demo-spin" size={26} /><h1>Loading PBMC3k</h1><p role="status">{message}</p></>}
  </main></div>;
}
