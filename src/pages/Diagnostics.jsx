import React, { useState, useEffect } from 'react';
import { Activity, RefreshCw, FolderOpen, CheckCircle2, XCircle, AlertTriangle, Terminal } from 'lucide-react';

const SUPPORTED_R_TARGET = 'R 4.5.x';
const DEFAULT_PACKAGES = {
  Seurat: null,
  dplyr: null,
  harmony: null,
  CellChat: null,
  plumber: null,
  jsonlite: null,
  ggplot2: null
};

function detectedVersionParts(version) {
  const match = String(version || '').match(/(\d+)\.(\d+)/);
  return match ? { major: match[1], minor: match[2] } : null;
}

function needsRTargetWarning(version) {
  const parts = detectedVersionParts(version);
  return !!parts && !(parts.major === '4' && parts.minor === '5');
}

export default function Diagnostics({ apiStatus }) {
  const [rscriptPath, setRscriptPath] = useState('');
  const [rscriptSource, setRscriptSource] = useState('');
  const [rVersion, setRVersion] = useState('Checking...');
  const [packages, setPackages] = useState(DEFAULT_PACKAGES);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    checkEnv();
  }, []);

  const checkEnv = async () => {
    setIsChecking(true);
    setRVersion('Checking...');
    if (window.electronAPI && window.electronAPI.checkREnv) {
      const result = await window.electronAPI.checkREnv();
      if (result.error) {
        setRVersion(`Error: ${result.error}`);
        setRscriptPath('Unknown');
        setRscriptSource('backend probe unavailable');
        setPackages(Object.fromEntries(Object.keys(DEFAULT_PACKAGES).map(name => [name, false])));
      } else {
        setRVersion(result.version || 'Unknown');
        setRscriptPath(result.rscriptPath || 'Unknown');
        setRscriptSource(result.rscriptSource || 'backend');
        setPackages({ ...DEFAULT_PACKAGES, ...(result.packages || {}) });
      }
    } else {
      setRVersion('Unknown');
      setRscriptPath('Unknown');
      setRscriptSource('browser API unavailable');
    }
    setIsChecking(false);
  };

  const PackageStatus = ({ name, status }) => (
    <div className="flex items-center justify-between p-3 bg-surface border border-border rounded-lg">
      <span className="font-medium">{name}</span>
      {status === null ? (
        <RefreshCw size={16} className="text-slate-400 animate-spin" />
      ) : status ? (
        <CheckCircle2 size={18} className="text-success" />
      ) : (
        <XCircle size={18} className="text-danger" />
      )}
    </div>
  );

  const versionWarning = needsRTargetWarning(rVersion)
    ? `Detected ${rVersion}. Supported local/dev target is ${SUPPORTED_R_TARGET}. Some optional packages, including CellChat, may require the pinned R 4.5 environment.`
    : null;

  return (
    <div className="h-full flex flex-col bg-background p-6 overflow-y-auto">
      <div className="max-w-4xl w-full mx-auto space-y-6">
        
        <header className="mb-8">
          <h1 className="text-3xl font-black text-text flex items-center gap-3">
            <Activity className="text-primary" size={32} />
            Diagnostics & Environment
          </h1>
          <p className="text-textMuted mt-2">Inspect the backend-detected R runtime and package availability for local development.</p>
        </header>

        {/* Engine Status & Path */}
        <section className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <Terminal size={20} className="text-slate-400" />
            R Engine Configuration
          </h2>
          
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-slate-400">Detected Rscript Executable</label>
                <button
                  onClick={checkEnv}
                  disabled={isChecking}
                  className="btn btn-primary text-xs flex items-center gap-2"
                >
                  <RefreshCw size={14} className={isChecking ? 'animate-spin' : ''} />
                  Refresh
                </button>
              </div>
              <div className="bg-background border border-border rounded-lg px-4 py-2 text-text font-mono text-sm break-all">
                {rscriptPath || 'Unknown'}
              </div>
              <p className="text-xs text-textMuted mt-2">
                Source: {rscriptSource || 'unknown'}. Configure Rscript through server environment/PATH, not a browser text field.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 bg-background rounded-lg border border-border">
                <div className="text-xs text-slate-400 uppercase font-bold tracking-wider mb-1">Detected R Version</div>
                <div className="font-medium text-text flex items-center gap-2">
                  {isChecking ? <RefreshCw size={14} className="animate-spin text-slate-400" /> : rVersion}
                </div>
              </div>
              <div className="p-4 bg-background rounded-lg border border-border">
                <div className="text-xs text-slate-400 uppercase font-bold tracking-wider mb-1">Supported Target</div>
                <div className="font-medium text-text">{SUPPORTED_R_TARGET}</div>
              </div>
              <div className="p-4 bg-background rounded-lg border border-border">
                <div className="text-xs text-slate-400 uppercase font-bold tracking-wider mb-1">API Connection</div>
                <div className="font-medium flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${/connected/i.test(apiStatus || '') && !/disconnected/i.test(apiStatus || '') ? 'bg-success' : 'bg-danger animate-pulse'}`}></div>
                  {apiStatus || 'Disconnected'}
                </div>
              </div>
            </div>

            {versionWarning && (
              <div className="p-4 bg-yellow-500/10 border border-yellow-500/40 rounded-lg text-yellow-300 flex items-start gap-3">
                <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
                <span className="text-sm font-medium">{versionWarning}</span>
              </div>
            )}
          </div>
        </section>

        {/* Packages Grid */}
        <section className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <FolderOpen size={20} className="text-slate-400" />
              Package Probe
            </h2>
            <span className="text-xs text-textMuted">Availability reported by backend diagnostics.</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {Object.keys(packages).map(pkg => (
              <PackageStatus key={pkg} name={pkg} status={packages[pkg]} />
            ))}
          </div>
        </section>

      </div>
    </div>
  );
}
