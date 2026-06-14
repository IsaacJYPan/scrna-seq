import React, { useState, useEffect, useRef } from 'react';
import { Activity, RefreshCw, FolderOpen, Wrench, CheckCircle2, XCircle, AlertTriangle, Terminal } from 'lucide-react';

export default function Diagnostics({ apiStatus }) {
  const [rscriptPath, setRscriptPath] = useState('');
  const [rVersion, setRVersion] = useState('Checking...');
  const [packages, setPackages] = useState({
    Seurat: null,
    dplyr: null,
    harmony: null,
    CellChat: null,
    plumber: null,
    jsonlite: null,
    ggplot2: null
  });
  const [isChecking, setIsChecking] = useState(true);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState('');
  
  const outputEndRef = useRef(null);

  useEffect(() => {
    if (window.electronAPI && window.electronAPI.getRScriptPath) {
      window.electronAPI.getRScriptPath().then(path => {
        setRscriptPath(path);
        checkEnv(path);
      });
    }
  }, []);

  useEffect(() => {
    if (outputEndRef.current) {
      outputEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [installOutput]);

  const checkEnv = async (pathToCheck) => {
    setIsChecking(true);
    setRVersion('Checking...');
    if (window.electronAPI && window.electronAPI.checkREnv) {
      const result = await window.electronAPI.checkREnv(pathToCheck);
      if (result.error) {
        setRVersion(`Error: ${result.error}`);
        setPackages({
          Seurat: false, dplyr: false, harmony: false, CellChat: false, plumber: false, jsonlite: false, ggplot2: false
        });
      } else {
        setRVersion(result.version);
        setPackages(result.packages);
      }
    }
    setIsChecking(false);
  };

  const handleSavePath = async () => {
    if (window.electronAPI && window.electronAPI.setRScriptPath) {
      await window.electronAPI.setRScriptPath(rscriptPath);
      checkEnv(rscriptPath);
      // Also restart plumber to use the new path if desired
      if (window.electronAPI.restartPlumber) {
        window.electronAPI.restartPlumber();
      }
    }
  };

  const handleInstall = () => {
    if (!window.electronAPI || !window.electronAPI.runRInstaller) return;
    
    setIsInstalling(true);
    setInstallOutput('Starting installation...\\n');
    
    const unsubs = [];
    
    const unsubOutput = window.electronAPI.onRInstallerOutput((output) => {
      setInstallOutput(prev => prev + output);
    });
    
    const unsubDone = window.electronAPI.onRInstallerDone((code) => {
      setInstallOutput(prev => prev + `\\nProcess exited with code ${code}\\n`);
      setIsInstalling(false);
      checkEnv(rscriptPath);
      unsubs.forEach(unsub => unsub());
    });
    
    unsubs.push(unsubOutput, unsubDone);
    
    window.electronAPI.runRInstaller(rscriptPath);
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

  const allGood = Object.values(packages).every(status => status === true) && !rVersion.startsWith('Error');

  return (
    <div className="h-full flex flex-col bg-background p-6 overflow-y-auto">
      <div className="max-w-4xl w-full mx-auto space-y-6">
        
        <header className="mb-8">
          <h1 className="text-3xl font-black text-text flex items-center gap-3">
            <Activity className="text-primary" size={32} />
            Diagnostics & Environment
          </h1>
          <p className="text-textMuted mt-2">Manage your R runtime, verify package dependencies, and repair your installation.</p>
        </header>

        {/* Engine Status & Path */}
        <section className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <Terminal size={20} className="text-slate-400" />
            R Engine Configuration
          </h2>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">Rscript Executable Path</label>
              <div className="flex gap-2">
                <input 
                  type="text" 
                  value={rscriptPath}
                  onChange={(e) => setRscriptPath(e.target.value)}
                  className="flex-1 bg-background border border-border rounded-lg px-4 py-2 text-text focus:outline-none focus:border-primary transition-colors"
                  placeholder="e.g., C:\\Program Files\\R\\R-4.5.1\\bin\\Rscript.exe"
                />
                <button 
                  onClick={handleSavePath}
                  disabled={isChecking || isInstalling}
                  className="btn btn-primary"
                >
                  Apply & Restart
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-background rounded-lg border border-border">
                <div className="text-xs text-slate-400 uppercase font-bold tracking-wider mb-1">R Version</div>
                <div className="font-medium text-text flex items-center gap-2">
                  {isChecking ? <RefreshCw size={14} className="animate-spin text-slate-400" /> : rVersion}
                </div>
              </div>
              <div className="p-4 bg-background rounded-lg border border-border">
                <div className="text-xs text-slate-400 uppercase font-bold tracking-wider mb-1">API Connection</div>
                <div className="font-medium flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${apiStatus?.includes('Connected') ? 'bg-success' : 'bg-danger animate-pulse'}`}></div>
                  {apiStatus || 'Disconnected'}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Packages Grid */}
        <section className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <FolderOpen size={20} className="text-slate-400" />
              Required Packages
            </h2>
            <button
              onClick={handleInstall}
              disabled={isChecking || isInstalling || allGood}
              className={`btn flex items-center gap-2 ${allGood ? 'bg-success/20 text-success cursor-not-allowed' : 'btn-primary'}`}
            >
              <Wrench size={16} />
              {allGood ? 'All Systems Go' : 'Install / Repair Missing'}
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {Object.keys(packages).map(pkg => (
              <PackageStatus key={pkg} name={pkg} status={packages[pkg]} />
            ))}
          </div>
        </section>

        {/* Installer Console */}
        {isInstalling || installOutput ? (
          <section className="bg-[#0f172a] border border-border rounded-xl overflow-hidden shadow-sm flex flex-col h-64">
            <div className="bg-surface px-4 py-2 border-b border-border flex items-center justify-between">
              <div className="text-sm font-bold flex items-center gap-2">
                <Terminal size={14} className="text-primary" />
                Installer Console
              </div>
              {isInstalling && <RefreshCw size={14} className="text-primary animate-spin" />}
            </div>
            <div className="p-4 flex-1 overflow-y-auto font-mono text-xs text-slate-300 whitespace-pre-wrap">
              {installOutput}
              <div ref={outputEndRef} />
            </div>
          </section>
        ) : null}
        
      </div>
    </div>
  );
}
