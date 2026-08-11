import React, { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';

const SUPPORTED_R_TARGET = 'R 4.5.x';

function detectedVersionParts(version) {
  const match = String(version || '').match(/(\d+)\.(\d+)/);
  return match ? { major: match[1], minor: match[2] } : null;
}

function needsRTargetWarning(version) {
  const parts = detectedVersionParts(version);
  return !!parts && !(parts.major === '4' && parts.minor === '5');
}

export default function Diagnostics({ apiStatus }) {
  const [rVersion, setRVersion] = useState('Checking...');
  const [runtimeStatus, setRuntimeStatus] = useState('unknown');
  const [isChecking, setIsChecking] = useState(true);

  const checkEnv = async () => {
    setIsChecking(true);
    setRVersion('Checking...');
    try {
      if (!window.electronAPI?.checkREnv) throw new Error('Support status is unavailable.');
      const result = await window.electronAPI.checkREnv();
      if (result.error) throw new Error(result.error);
      setRVersion(result.version || 'Unknown');
      setRuntimeStatus(result.runtimeStatus || 'unknown');
    } catch {
      setRVersion('Unavailable');
      setRuntimeStatus('unavailable');
    } finally {
      setIsChecking(false);
    }
  };

  useEffect(() => {
    checkEnv();
  }, []);

  const versionWarning = needsRTargetWarning(rVersion)
    ? `Detected ${rVersion}. The supported local/development target is ${SUPPORTED_R_TARGET}.`
    : null;
  const computeAvailable = /^(ok|ready|connected)$/i.test(runtimeStatus);

  return (
    <div className="h-full flex flex-col bg-background p-6 overflow-y-auto">
      <div className="max-w-3xl w-full mx-auto space-y-6">
        <header className="mb-4">
          <h1 className="text-3xl font-black text-text flex items-center gap-3">
            <Activity className="text-primary" size={32} />
            Technical support
          </h1>
          <p className="text-textMuted mt-2">A secondary support surface with safe availability information. Local paths, package probes, and runtime topology are not shown here.</p>
        </header>

        <section className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold">Compute support</h2>
              <p className="mt-1 text-sm text-textMuted">Use this status when reporting an issue to your local support contact.</p>
            </div>
            <button
              onClick={checkEnv}
              disabled={isChecking}
              className="btn btn-secondary text-sm inline-flex items-center gap-2"
            >
              <RefreshCw size={15} className={isChecking ? 'animate-spin' : ''} />
              Refresh status
            </button>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="p-4 bg-background rounded-lg border border-border">
              <div className="text-xs text-slate-400 uppercase font-bold tracking-wider mb-1">Compute status</div>
              <div className="font-medium text-text flex items-center gap-2">
                <CheckCircle2 size={16} className={computeAvailable ? 'text-success' : 'text-textMuted'} />
                {isChecking ? 'Checking…' : computeAvailable ? 'Compute available' : 'Compute unavailable'}
              </div>
            </div>
            <div className="p-4 bg-background rounded-lg border border-border">
              <div className="text-xs text-slate-400 uppercase font-bold tracking-wider mb-1">Detected R version</div>
              <div className="font-medium text-text">{isChecking ? 'Checking…' : rVersion}</div>
            </div>
            <div className="p-4 bg-background rounded-lg border border-border">
              <div className="text-xs text-slate-400 uppercase font-bold tracking-wider mb-1">Supported target</div>
              <div className="font-medium text-text">{SUPPORTED_R_TARGET}</div>
            </div>
          </div>

          {versionWarning && (
            <div className="mt-4 p-4 bg-yellow-500/10 border border-yellow-500/40 rounded-lg text-yellow-300 flex items-start gap-3">
              <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
              <span className="text-sm font-medium">{versionWarning}</span>
            </div>
          )}
          {apiStatus && <p className="mt-4 text-xs text-textMuted">Application status: {apiStatus}</p>}
        </section>
      </div>
    </div>
  );
}
