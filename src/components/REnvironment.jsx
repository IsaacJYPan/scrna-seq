import React, { useEffect, useRef, useState } from 'react';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export default function REnvironment({ reference, projectId }) {
  const [manifest, setManifest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => { request.current += 1; setManifest(null); setError(''); setBusy(false); return () => { request.current += 1; }; }, [reference?.id, projectId]);
  const inspect = async () => {
    const current = ++request.current;
    setBusy(true); setError('');
    try {
      const value = await window.electronAPI.getExpertREnvironment(projectId);
      if (value?.r?.version !== reference.rVersion || value?.runtime?.imageId !== reference.imageId) throw new Error('Environment changed');
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value)) + '\n'));
      if (Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') !== reference.manifestSha256) throw new Error('Environment changed');
      if (request.current === current) setManifest(value);
    } catch { if (request.current === current) setError('The exact environment could not be verified. Check R availability before trying again.'); }
    finally { if (request.current === current) setBusy(false); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `r-environment-${reference.manifestSha256}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  if (!reference) return <p className="text-sm text-textMuted">An exact R environment has not been recorded for this runtime.</p>;
  return <section className="card p-4 space-y-3" aria-labelledby="r-environment-title">
    <h3 id="r-environment-title" className="font-medium">Exact R environment</h3>
    <p className="text-sm text-textMuted">R {reference.rVersion} · Bioconductor {reference.bioconductor}</p>
    <p className="text-xs break-all text-textMuted">Environment version: <code>{reference.id}</code></p>
    <p className="text-sm text-textMuted">Each run pins this version and retains its package lock. Keep the original immutable runtime image to restore it on a compatible Linux worker. The container userspace is recorded; the host kernel and hardware are outside this snapshot.</p>
    <button type="button" className="btn btn-secondary text-xs" disabled={busy || !window.electronAPI?.getExpertREnvironment} onClick={inspect}>{busy ? 'Verifying environment…' : 'Inspect package lock'}</button>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {manifest && <>
      <p className="text-sm text-textMuted">{manifest.packages.length} R packages · {manifest.systemPackages.length} system packages · {manifest.runtime.distribution.id} {manifest.runtime.distribution.version}</p>
      <p className="text-xs break-all text-textMuted">Pinned image: <code>{manifest.runtime.imageReference}</code></p>
      <button type="button" className="btn btn-secondary text-xs" onClick={download}>Download environment manifest</button>
      <details><summary className="text-sm cursor-pointer">Installed R package versions and sources</summary><div className="max-h-72 overflow-auto mt-2"><table className="w-full text-xs text-left"><thead><tr><th className="p-2">Package</th><th className="p-2">Version</th><th className="p-2">Source</th></tr></thead><tbody>{manifest.packages.map(pkg => <tr key={pkg.name}><td className="p-2">{pkg.name}</td><td className="p-2">{pkg.version}</td><td className="p-2 break-all">{pkg.source.url || pkg.source.gitUrl || pkg.source.repository || (pkg.source.kind === 'r-distribution' ? 'R distribution' : 'Source not recorded')}{pkg.source.remoteSha ? ` @ ${pkg.source.remoteSha}` : ''}</td></tr>)}</tbody></table></div></details>
      <p className="text-xs text-textMuted">Source metadata comes from installed package records. Missing origins are marked explicitly; source archives are retained by the pinned image only when it contains them. Restore the image, rather than installing current package releases.</p>
    </>}
  </section>;
}
