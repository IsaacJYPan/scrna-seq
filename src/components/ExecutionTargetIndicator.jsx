import React, { useState } from 'react';
import DetailsPopover from './DetailsPopover';
import ServerReadiness from './ServerReadiness';
import useExecutionTarget from '../runtime/useExecutionTarget';

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
  const { target, blocked, error: connectionError } = useExecutionTarget();
  const [error, setError] = useState('');
  const [readinessOpen, setReadinessOpen] = useState(false);
  const shell = window.desktopShell;

  const endpoint = target?.endpoint || window.location.origin;
  const runtime = R_STATUS[deploymentPolicy.expertRStatus?.state]
    || (deploymentPolicy.demoMode ? 'Guided demo' : deploymentPolicy.expertREnabled ? 'Custom R available' : 'Custom R status unavailable');
  const disconnected = target?.sshTunnel?.state && target.sshTunnel.state !== 'connected';
  return <><div aria-label="Execution target" className="shrink-0 h-12 flex items-center justify-between gap-3 border-b border-border bg-surface px-4 text-xs text-text">
    <div className="min-w-0 flex-1">
      <span className="block truncate font-medium" title={endpoint}>Compute: {target?.name || endpoint}</span>
      <span className="block truncate text-textMuted" title="Availability of custom R on this server">{runtime}</span>
      {target?.sshTunnel && <span role="status" className={`block truncate ${disconnected ? 'text-amber-800 dark:text-amber-200' : 'text-textMuted'}`}>
        {disconnected ? 'SSH tunnel disconnected' : 'SSH tunnel connected'}
      </span>}
      {(error || connectionError) && <span role="status" className="block truncate" title={error || connectionError}>Connection needs attention</span>}
    </div>
    <DetailsPopover label="Connection details" className="shrink-0">
      <p className="font-medium break-words">Server: {target?.name || endpoint}</p>
      {target && <p className="mt-1 break-all text-textMuted">{endpoint}</p>}
      <p className="mt-3">{runtime}. This describes custom R access; standard analysis tools have their own prerequisites.</p>
      <p className="mt-3">Analysis jobs, recipes, and R commands run on this server. Your browser displays bounded previews and figures.</p>
      {disconnected && <p className="mt-3 text-amber-800 dark:text-amber-200">SSH tunnel disconnected. Reconnect through server settings.</p>}
      {blocked && <p role="status" className="mt-3 text-amber-800 dark:text-amber-200">New server work is blocked until this connection is restored. Existing work is not rerun automatically; reconnect to inspect its retained status.</p>}
      {(error || connectionError) && <p role="alert" className="mt-3">{error || connectionError}</p>}
      {userId && <button type="button" data-close-popover className="btn btn-secondary mt-3" onClick={() => setReadinessOpen(true)}>Check server readiness</button>}
      {typeof shell?.openTargetSettings === 'function' && <button type="button" className="btn btn-secondary mt-3" onClick={() => {
      setError('');
      shell.openTargetSettings().catch(() => setError('Server settings could not be opened. Try the desktop connection menu.'));
      }}>Change server</button>}
    </DetailsPopover>
  </div>{readinessOpen && <ServerReadiness projectId={projectId} userId={userId} target={target} onClose={() => setReadinessOpen(false)} />}</>;
}
