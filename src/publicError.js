const DEFAULT_PUBLIC_ERROR = 'We could not complete this request. Please review the settings and try again.';

const UNSAFE_ERROR_DETAIL = /(?:[A-Za-z]:[\\/]|(?:https?|file):\/\/|\/__private_vault__\/|\bvault\/|\bstorage_?(?:uri|key)\b|\b(?:claim_?token|state_?key)\b|\b(?:rscript|plumber|postgres|docker|compose|node_modules)\b|\b(?:traceback|stack trace|execution halted|internal server|exception)\b|\b(?:job|art|ao|proj|br|rev|aud|com)_[A-Za-z0-9_-]+\b|\buser-\d+:obj-)/i;
const EXPERT_R_OWNER_MESSAGES = new Set([
  'The R script exceeded the per-run output storage limit.',
  'The R script could not be parsed. Check its syntax and line endings.',
  'A requested R package is not included in the approved package profile.',
  'The R script referenced an object or function that is not available.',
  'The R script could not find a selected input file.',
  'The R script stopped with an error. Check input names, columns, and function arguments.',
  'Expert R storage capacity is temporarily unavailable. Try again later.',
]);
const CELLCHAT_OWNER_MESSAGES = new Set([
  'CellChat is unavailable in the current analysis runtime. Ask an operator to enable the required package profile.',
  'CellChat needs valid clustering or identity labels. Run clustering or choose current identities and try again.',
  'CellChat needs between two and 32 populated groups. Review the selected grouping and try again.',
  'At least two groups must meet the minimum cell threshold. Lower the threshold or revise the grouping.',
  'CellChat requires an RNA assay in the saved analysis.',
  'CellChat requires normalized RNA data. Run normalization and try again.',
  'Too few signaling genes overlap the selected CellChat database. Check the species and RNA assay.',
  'CellChat could not construct a valid input. Review the grouping, assay, species, and saved analysis.',
]);

function unpackError(value) {
  const raw = String(value?.message || value || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.error || raw).trim();
  } catch {
    return raw;
  }
}

// Server errors are a hostile boundary from the perspective of a researcher
// interface. Preserve only short, user-actionable scientific or access messages;
// everything else becomes a stable, non-technical recovery message.
export function publicErrorMessage(value, fallback = DEFAULT_PUBLIC_ERROR) {
  const message = unpackError(value).replace(/\s+/g, ' ').trim();
  if (!message || message.length > 240 || UNSAFE_ERROR_DETAIL.test(message)) return fallback;

  if (EXPERT_R_OWNER_MESSAGES.has(message)) return message;
  if (CELLCHAT_OWNER_MESSAGES.has(message)) return message;

  if (/^(?:R service|Analysis compute) is busy\b/i.test(message)) {
    return 'Analysis compute is busy. Wait a moment and try again.';
  }
  if (/^R request rate limit exceeded\b/i.test(message)) {
    return 'Too many analysis requests were started. Wait a moment and try again.';
  }

  if (/^no (?:cells|features|samples|biological samples)\b/i.test(message)) return message;
  if (/^(?:select|choose|enter|provide|add|set)\b/i.test(message)) return message;
  if (/^(?:at least|exactly) \d+\b/i.test(message)) return message;
  if (/\b(?:last owner|own role|member already|role assignment)\b/i.test(message)) return message;
  if (/\b(?:not authorized|permission|access)\b/i.test(message)) return 'You do not have access to this project action.';
  if (/\b(?:not found|no longer available|missing)\b/i.test(message)) return 'The requested saved analysis is no longer available.';

  return fallback;
}

export function isTransientComputeBusy(value) {
  return publicErrorMessage(value) === 'Analysis compute is busy. Wait a moment and try again.';
}

export { DEFAULT_PUBLIC_ERROR };
