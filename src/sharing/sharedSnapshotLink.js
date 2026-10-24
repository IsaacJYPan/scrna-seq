const PREFIX = '#/shared-snapshots/', VERSION = `${PREFIX}v1/`, HASH_LIMIT = 512, URL_LIMIT = 4096;
const fields = ['serviceId', 'projectId', 'analysisId', 'publicationId', 'snapshotSha256'];
const patterns = [/^svc_[a-f0-9]{32}$/, /^proj_[a-f0-9]{16,40}$/, /^ra_[a-f0-9]{24}$/, /^aspub_[a-f0-9]{24}$/, /^[a-f0-9]{64}$/];
const invalid = () => Object.assign(new Error('Use an exact shared snapshot link from this workspace.'), { code: 'INVALID_SHARED_SNAPSHOT_LINK' });

function targetCopy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))
      || fields.some((key, index) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')
        || typeof descriptors[key].value !== 'string' || !patterns[index].test(descriptors[key].value))) throw invalid();
  return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
}

export function parseSharedSnapshotHash(hash) {
  if (typeof hash !== 'string') return { kind: 'invalid' };
  // An incomplete/future shared route must not fall through to a live workspace.
  let segment = hash.replace(/^#\/?/, '').split('/')[0];
  try { segment = decodeURIComponent(segment); } catch { /* Never accept a decoded route. */ }
  if (!segment.toLowerCase().startsWith('shared-snapshots')) return null;
  if (hash.length > HASH_LIMIT || !hash.startsWith(VERSION)) return { kind: 'invalid' };
  const values = hash.slice(VERSION.length).split('/');
  if (values.length !== fields.length) return { kind: 'invalid' };
  try { return { kind: 'snapshot', target: targetCopy(Object.fromEntries(fields.map((key, index) => [key, values[index]]))) }; }
  catch { return { kind: 'invalid' }; }
}

export function buildSharedSnapshotHash(input) {
  const target = targetCopy(input), hash = VERSION + fields.map(key => target[key]).join('/');
  if (hash.length > HASH_LIMIT) throw invalid();
  return hash;
}

export function buildSharedSnapshotUrl(input, currentUrl) {
  const hash = buildSharedSnapshotHash(input);
  if (typeof currentUrl !== 'string' || !currentUrl || currentUrl.length > URL_LIMIT || /[\s\p{Cc}\p{Cf}\\]/u.test(currentUrl)) throw invalid();
  // Inspect the literal path before URL would normalize encoded/dot segments.
  const original = /^https?:\/\/[^/?#]+(\/[^?#]*)?(?:[?#].*)?$/i.exec(currentUrl);
  if (!original || currentUrl.split(/[?#]/, 1)[0].includes('%')
      || (original[1] || '').split('/').some(value => value === '.' || value === '..')) throw invalid();
  let url;
  try { url = new URL(currentUrl); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname.includes('%')) throw invalid();
  url.search = ''; url.hash = hash;
  const result = url.href;
  if (result.length > URL_LIMIT) throw invalid();
  return result;
}
