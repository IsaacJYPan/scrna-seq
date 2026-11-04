'use strict';

// Bounded projection of a result's summary for agents and comparison views:
// at most 30 simple fields (numbers, booleans, short strings), nothing else.

function parseMetadata(text) {
  if (text && typeof text === 'object') return text;
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

function boundedSummary(metadata) {
  const summary = metadata && typeof metadata.summary === 'object' && metadata.summary ? metadata.summary : {};
  const out = {};
  for (const [key, value] of Object.entries(summary).slice(0, 30)) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && value.length <= 80) out[key] = value;
  }
  return out;
}

module.exports = { boundedSummary, parseMetadata };
