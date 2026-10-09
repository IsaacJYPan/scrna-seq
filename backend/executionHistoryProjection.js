'use strict';

const crypto = require('node:crypto');
const LIMITS = Object.freeze({ page: 50, detailBytes: 256 * 1024, sourceBytes: 32 * 1024, jsonBytes: 64 * 1024, outputs: 64, provenance: 8, snapshots: 40 });
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9_-]{0,119}$/;
const sensitiveKey = /(?:password|secret|token|credential|authorization|cookie|private.?key|storage|(?:^|_)path|uri|url|worker.?id|claim|state.?key|session.?id)/i;
const sensitiveText = /(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9]|(?:https?|ssh|postgres(?:ql)?):\/\/[^\s/]+@|\bBearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:^|[\s"'])\/(?!work(?:\/|["'\s]))[A-Za-z0-9._-]+\/|\b(?:password|secret|(?:api[_-]?)?token)\s*(?:=|:)\s*["']?[^\s"']+)/i;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function parse(value, fallback = {}) { if (typeof value !== 'string') return value ?? fallback; if (Buffer.byteLength(value) > 1024 * 1024) return fallback; try { return JSON.parse(value); } catch { return fallback; } }
function timestamp(value) { const date = new Date(value); return value != null && Number.isFinite(date.getTime()) ? date.toISOString() : null; }
function safeText(value, maximum = 160) { return typeof value === 'string' && value.length <= maximum && !sensitiveText.test(value) ? value : null; }
function safeId(value) { return typeof value === 'string' && ID.test(value) ? value : null; }
function observedRuntimeMetadata(values) {
  const version = value => typeof value === 'string' && /^[A-Za-z0-9.+-]{1,80}$/.test(value) ? value : null;
  const packageNames = { seurat: 'Seurat', seuratVersion: 'Seurat', annotationDbi: 'AnnotationDbi', goDb: 'GO.db',
    clusterProfiler: 'clusterProfiler', fgsea: 'fgsea',
    cellchat: 'CellChat', cellChat: 'CellChat', edgeR: 'edgeR', limma: 'limma' };
  let rVersion = null; const packages = new Map();
  for (const value of values.slice(0, 128)) {
    if (!value || typeof value !== 'object') continue;
    const candidates = [value.environmentObserved, value.loaded, value.summary, value.runtime, value];
    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      const r = item.rVersion || item.packageVersions?.r;
      if (!rVersion && typeof r === 'string' && /^\d+\.\d+\.\d+(?:[.+-][A-Za-z0-9.-]+)?$/.test(r) && r.length <= 80) rVersion = r;
      for (const [key, name] of Object.entries(packageNames)) {
        const number = version(item.packageVersions?.[key] || item[key]);
        if (number && packages.size < 100 && !packages.has(name)) packages.set(name, number);
      }
      if (item === value.environmentObserved && Array.isArray(item.packages)) {
        for (const entry of item.packages.slice(0, 100)) {
          if (typeof entry?.name === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,79}$/.test(entry.name)
              && version(entry.version) && packages.size < 100 && !packages.has(entry.name)) packages.set(entry.name, entry.version);
        }
      }
    }
  }
  return rVersion || packages.size ? { rVersion, packages: [...packages].map(([name, number]) => ({ name, version: number })) } : null;
}
function boundedJSON(value) {
  let changed = false;
  function visit(item, depth) {
    if (depth > 5) { changed = true; return '[Omitted: nesting limit]'; }
    if (item == null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') { if (item.length > 2000 || sensitiveText.test(item)) { changed = true; return '[Omitted: private or oversized value]'; } return item; }
    if (Array.isArray(item)) { if (item.length > 100) changed = true; return item.slice(0, 100).map(entry => visit(entry, depth + 1)); }
    if (typeof item !== 'object') { changed = true; return null; }
    const result = {};
    if (Object.keys(item).length > 100) changed = true;
    for (const [key, entry] of Object.entries(item).slice(0, 100)) {
      if (key.length > 160 || sensitiveKey.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) { changed = true; continue; }
      result[key] = visit(entry, depth + 1);
    }
    return result;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.jsonBytes) return { value: null, redacted: true };
  return { value: result, redacted: changed };
}
function sourceRecord(code, recordedHash, language = 'R') {
  const actual = typeof code === 'string' && code.length ? digest(code) : null;
  const hash = HEX.test(recordedHash || '') ? recordedHash : actual;
  if (actual && hash !== actual) return { language, sha256: hash, code: null, precision: 'inconsistent', note: 'Retained source does not match its recorded checksum.' };
  if (!actual) return { language, sha256: hash, code: null, precision: hash ? 'hash-only' : 'unavailable', note: hash ? 'Only the source checksum was retained.' : 'Exact executed source was not retained.' };
  if (Buffer.byteLength(code) > LIMITS.sourceBytes || sensitiveText.test(code)) return { language, sha256: hash, code: null, precision: 'withheld', note: 'Source content contains private transport/path details or exceeds the inspection limit; its exact checksum is retained.' };
  return { language, sha256: hash, code, precision: 'exact-retained', note: null };
}
function reference(projectId, artifactId, checksum, sizeBytes, name, basis) {
  const versionId = safeId(artifactId); const sha256 = HEX.test(checksum || '') ? checksum : null;
  const size = Number(sizeBytes);
  return { name: safeText(name) || 'Artifact', versionId, sha256, sizeBytes: Number.isSafeInteger(size) && size >= 0 && sizeBytes != null ? size : null, precision: sha256 && versionId ? 'recorded-version' : 'identity-only', basis,
    reference: sha256 && versionId ? { artifactId: versionId, versionId, projectId, sha256 } : null };
}
function jobKind(job, link, owns) { return owns && link ? 'workflow' : job.job_type === 'expert.r.v1' ? 'expert-r' : 'guided'; }
function summary(row, kind, owns, ownerName) {
  return { id: row.id, projectId: row.project_id, kind, operation: safeText(row.operation || row.job_type) || 'Recorded operation', status: ['queued', 'running', 'completed', 'failed', 'canceled'].includes(row.status) ? row.status : kind === 'provenance' ? 'recorded' : 'completed', createdAt: timestamp(row.created_at), startedAt: timestamp(row.started_at), completedAt: timestamp(row.completed_at), owner: { id: String(row.owner_user_id ?? row.created_by_user_id), displayName: safeText(ownerName) || 'Project researcher' }, detailAvailable: owns };
}

module.exports = { LIMITS, HEX, ID, digest, parse, timestamp, safeText, safeId, boundedJSON, sourceRecord, reference, jobKind, summary, observedRuntimeMetadata };
