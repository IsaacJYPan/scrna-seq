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
  const date = new Date(value || Date.now());
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
