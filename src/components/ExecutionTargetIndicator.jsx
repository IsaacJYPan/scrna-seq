import React, { useEffect, useState } from 'react';

const R_STATUS = {
  ready: 'R available',
  'not-configured': 'R setup required',
  unreachable: 'R unavailable',
  incompatible: 'R update required',
  'access-required': 'R access required',
  'access-revoked': 'R access revoked',
  'demo-disabled': 'Guided demo',
};

export default function ExecutionTargetIndicator({ deploymentPolicy = {} }) {
  const [target, setTarget] = useState(null);
  const [error, setError] = useState('');
  const shell = window.desktopShell;
  useEffect(() => {
    let active = true;
    if (typeof shell?.getCurrentTarget !== 'function') return undefined;
    shell.getCurrentTarget().then(value => {
      if (active && value?.status === 'connected') setTarget(value);
    }).catch(() => {
      if (active) setError('Connection details are unavailable.');
    });
    return () => { active = false; };
  }, [shell]);

  const endpoint = target?.endpoint || window.location.origin;
  const runtime = R_STATUS[deploymentPolicy.expertRStatus?.state]
    || (deploymentPolicy.demoMode ? 'Guided demo' : deploymentPolicy.expertREnabled ? 'R available' : 'R status unavailable');
  return <div aria-label="Execution target" className="shrink-0 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border bg-surface px-4 py-2 text-xs text-text">
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-medium">Server: {target?.name || endpoint}</span>
      {target && <span className="max-w-full truncate text-textMuted" title={endpoint}>{endpoint}</span>}
      <span className="text-textMuted" title="Availability of custom R on this server">{runtime}</span>
      {error && <span role="status">{error}</span>}
    </div>
    {typeof shell?.openTargetSettings === 'function' && <button type="button" className="shrink-0 font-medium underline" onClick={() => {
      setError('');
      shell.openTargetSettings().catch(() => setError('Server settings could not be opened. Try the desktop connection menu.'));
    }}>Change server</button>}
  </div>;
}
