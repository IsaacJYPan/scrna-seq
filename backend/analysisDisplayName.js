'use strict';

const MAX_DISPLAY_NAME_LENGTH = 200;

function analysisBaseName(value) {
  let name = typeof value === 'string' ? value.trim() : '';
  if (!name) return 'Analysis';

  let previous;
  do {
    previous = name;
    name = name.replace(/^(?:Saved\s+|Fork of\s+)/i, '').trim();
  } while (name && name !== previous);

  // Remove a prior generated version suffix so repeated save/fork operations do
  // not grow names indefinitely. User-authored names without this exact suffix
  // remain untouched.
  name = name.replace(/\s+\u00b7\s+(?:Saved|Branch)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}Z$/i, '').trim();
  return name || 'Analysis';
}

function formatUtcMinute(value) {
  let normalized = value || Date.now();
  // pgDatabase's canonical TIMESTAMPTZ wire value is UTC but intentionally
  // omits an offset ("YYYY-MM-DD HH:MM:SS"). Date parses that shape as local
  // time, which shifted generated version labels on non-UTC hosts. Preserve the
  // database contract while making its UTC meaning explicit at this boundary.
  if (typeof normalized === 'string'
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized.trim())) {
    normalized = `${normalized.trim().replace(' ', 'T')}Z`;
  }
  const date = new Date(normalized);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return safe.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

function derivedAnalysisDisplayName(sourceName, kind, createdAt) {
  const label = kind === 'branch' ? 'Branch' : 'Saved';
  const suffix = ` \u00b7 ${label} ${formatUtcMinute(createdAt)}`;
  const maxBaseLength = Math.max(1, MAX_DISPLAY_NAME_LENGTH - suffix.length);
  return `${analysisBaseName(sourceName).slice(0, maxBaseLength).trim()}${suffix}`;
}

module.exports = {
  analysisBaseName,
  derivedAnalysisDisplayName,
};
