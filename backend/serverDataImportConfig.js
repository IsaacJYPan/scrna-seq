'use strict';

const path = require('node:path');
const os = require('node:os');
const { getPrivateRArtifactPolicy } = require('./privateRArtifactPolicy');

const ROOT_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PROJECT_ID = /^proj_[A-Za-z0-9_-]{3,128}$/;
const FORBIDDEN_SEGMENTS = new Set(['node_modules', 'vault', 'sessions', 'credentials']);
function importError(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function invalid() { return importError('SERVER_IMPORT_CONFIG_INVALID', 'SERVER_DATA_IMPORT_ROOTS must contain distinct, dedicated absolute data directories with exact project and account grants.'); }
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
const controls = value => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
function safeLine(value, maximum) { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !controls(value); }

function serverDataImportRoots(env = process.env, { cwd = process.cwd(), home = os.homedir() } = {}) {
  const raw = env.SERVER_DATA_IMPORT_ROOTS;
  if (raw === undefined || raw === '') return [];
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536) throw invalid();
  let values;
  try { values = JSON.parse(raw); } catch { throw invalid(); }
  if (!Array.isArray(values) || values.length > 32) throw invalid();
  const protectedPaths = [cwd, path.resolve(env.STORAGE_ROOT || path.join(cwd, 'data')), path.resolve(env.VAULT_ROOT || path.join(cwd, 'vault')),
    ...['.ssh', '.aws', '.config', '.git'].map(name => path.join(home, name))];
  const systemRoots = process.platform === 'win32'
    ? [env.SystemRoot || env.WINDIR, env.ProgramFiles, env.ProgramData].filter(Boolean)
    : ['/etc', '/proc', '/sys', '/dev', '/run', '/boot', '/usr', '/bin', '/sbin'];
  const ids = new Set(); const roots = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id', 'label', 'path', 'grants'].includes(key))
        || !ROOT_ID.test(value.id || '') || ids.has(value.id) || !safeLine(value.label, 80)
        || typeof value.path !== 'string' || !path.isAbsolute(value.path) || controls(value.path)
        || !Array.isArray(value.grants) || value.grants.length < 1 || value.grants.length > 128) throw invalid();
    const directory = path.resolve(value.path);
    if (directory === path.parse(directory).root || directory === path.resolve(home)
        || protectedPaths.some(location => contains(directory, path.resolve(location)) || contains(path.resolve(location), directory))
        || systemRoots.some(location => contains(path.resolve(location), directory))
        || directory.split(path.sep).some(segment => segment.startsWith('.') || FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))
        || roots.some(root => contains(root.path, directory) || contains(directory, root.path))) throw invalid();
    const grants = []; const seen = new Set();
    for (const grant of value.grants) {
      if (!grant || typeof grant !== 'object' || Array.isArray(grant) || Object.keys(grant).some(key => !['projectId', 'ownerUserId'].includes(key))
          || !PROJECT_ID.test(grant.projectId || '') || !Number.isSafeInteger(grant.ownerUserId) || grant.ownerUserId < 1) throw invalid();
      const key = `${grant.projectId}:${grant.ownerUserId}`;
      if (seen.has(key)) throw invalid();
      seen.add(key); grants.push(Object.freeze({ projectId: grant.projectId, ownerUserId: grant.ownerUserId }));
    }
    ids.add(value.id); roots.push(Object.freeze({ id: value.id, label: value.label.trim(), path: directory, grants: Object.freeze(grants) }));
  }
  return Object.freeze(roots);
}

function relativeSelection(raw, { directory = false } = {}) {
  if (directory && (raw === '' || raw === undefined)) return '';
  if (typeof raw !== 'string' || !raw || raw.length > 1024 || raw.includes('\\') || raw.includes('%') || controls(raw) || raw.includes(':') || raw.startsWith('/')) {
    throw importError('SERVER_IMPORT_PATH_INVALID', 'Select a relative file or directory inside an authorized data root.');
  }
  const segments = raw.split('/');
  if (segments.length > 32 || segments.some(segment => !segment || segment === '..' || segment.startsWith('.') || segment.length > 240
      || segment.endsWith('.') || segment.endsWith(' ') || FORBIDDEN_SEGMENTS.has(segment.toLowerCase())
      || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) {
    throw importError('SERVER_IMPORT_PATH_INVALID', 'Hidden, private, and unsafe paths cannot be imported.');
  }
  return raw;
}

function importLimits(env = process.env) {
  const policy = getPrivateRArtifactPolicy(env);
  return { maxFileBytes: policy.maxInputFileBytes, managedQuotaBytes: policy.managedQuotaBytes, maximumVersions: 200,
    maximumPageEntries: 100, maximumDirectoryEntries: 10000, transferTimeoutSeconds: policy.transferTimeoutSeconds };
}

module.exports = { serverDataImportRoots, relativeSelection, importLimits, importError, ROOT_ID, contains };
