import React, { useEffect, useState } from 'react';
import DetailsPopover from './DetailsPopover';
import ServerReadiness from './ServerReadiness';

const R_STATUS = {
  ready: 'Custom R available',
  'not-configured': 'Custom R setup required',
  unreachable: 'Custom R unavailable',
  incompatible: 'Custom R update required',
  'access-required': 'Custom R access required',
  'access-revoked': 'Custom R access revoked',
  'demo-disabled': 'Guided demo',
};

export default function ExecutionTargetIndicator({ deploymentPolicy = {}, projectId, userId }) {
  const [target, setTarget] = useState(null);
  const [error, setError] = useState('');
  const [readinessOpen, setReadinessOpen] = useState(false);
  const shell = window.desktopShell;
  useEffect(() => {
    let active = true;
    let receivedStatus = false;
    let targetId = null;
    if (typeof shell?.getCurrentTarget !== 'function') return undefined;
    const unsubscribe = typeof shell.onTargetStatus === 'function' ? shell.onTargetStatus(value => {
      if (!active || !value || (value.id && targetId && value.id !== targetId)) return;
      receivedStatus = true;
      targetId = value.id || targetId;
      setTarget(value);
    }) : null;
    shell.getCurrentTarget().then(value => {
      if (active && !receivedStatus && value && typeof value === 'object') {
        targetId = value.id || null;
        setTarget(value);
      }
    }).catch(() => {
      if (active) setError('Connection details are unavailable.');
    });
    return () => { active = false; if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [shell]);

  const endpoint = target?.endpoint || window.location.origin;
  const runtime = R_STATUS[deploymentPolicy.expertRStatus?.state]
    || (deploymentPolicy.demoMode ? 'Guided demo' : deploymentPolicy.expertREnabled ? 'Custom R available' : 'Custom R status unavailable');
  const disconnected = target?.sshTunnel?.state && target.sshTunnel.state !== 'connected';
  return <><div aria-label="Execution target" className="shrink-0 h-12 flex items-center justify-between gap-3 border-b border-border bg-surface px-4 text-xs text-text">
    <div className="min-w-0 flex-1">
      <span className="block truncate text-textMuted" title="Availability of custom R on this server">{runtime}</span>
      {target?.sshTunnel && <span role="status" className={`block truncate ${disconnected ? 'text-amber-800 dark:text-amber-200' : 'text-textMuted'}`}>
        {disconnected ? 'SSH tunnel disconnected' : 'SSH tunnel connected'}
      </span>}
      {error && <span role="status" className="block truncate" title={error}>Connection needs attention</span>}
    </div>
    <DetailsPopover label="Connection details" className="shrink-0">
      <p className="font-medium break-words">Server: {target?.name || endpoint}</p>
      {target && <p className="mt-1 break-all text-textMuted">{endpoint}</p>}
      <p className="mt-3">{runtime}. This describes custom R access; standard analysis tools have their own prerequisites.</p>
      {disconnected && <p className="mt-3 text-amber-800 dark:text-amber-200">SSH tunnel disconnected. Reconnect through server settings.</p>}
      {error && <p role="alert" className="mt-3">{error}</p>}
      {userId && <button type="button" data-close-popover className="btn btn-secondary mt-3" onClick={() => setReadinessOpen(true)}>Check server readiness</button>}
      {typeof shell?.openTargetSettings === 'function' && <button type="button" className="btn btn-secondary mt-3" onClick={() => {
      setError('');
      shell.openTargetSettings().catch(() => setError('Server settings could not be opened. Try the desktop connection menu.'));
      }}>Change server</button>}
    </DetailsPopover>
  </div>{readinessOpen && <ServerReadiness projectId={projectId} userId={userId} target={target} onClose={() => setReadinessOpen(false)} />}</>;
}
