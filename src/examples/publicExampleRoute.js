import { PUBLIC_QC_RETENTION_V1 } from '../../shared/publicSavedExample.mjs';

export function parsePublicExampleHash(hash) {
  if (typeof hash !== 'string') return null;
  let namespace = hash.replace(/^#\/*/, '').split('/')[0];
  try { namespace = decodeURIComponent(namespace).replace(/^\/+/, ''); } catch { /* Encoded routes are never accepted. */ }
  if (!namespace.toLowerCase().startsWith('examples')) return null;
  return hash === PUBLIC_QC_RETENTION_V1.route ? { kind: 'public-example' } : { kind: 'invalid-example' };
}

export function buildPublicExampleUrl(currentUrl) {
  if (typeof currentUrl !== 'string' || currentUrl.length > 4096 || /[\s\p{Cc}\p{Cf}\\]/u.test(currentUrl)) return null;
  let url;
  try { url = new URL(currentUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
  url.search = ''; url.hash = PUBLIC_QC_RETENTION_V1.route;
  return url.href.length <= 4096 ? url.href : null;
}
