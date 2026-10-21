// Error classification for worker handlers and job recovery. Only marked messages may reach job logs.

const SAFE_HANDLER_DOMAIN_MESSAGES = Object.freeze({
  ANALYSIS_OBJECT_NOT_FOUND: 'Analysis object not found.',
  CELLCHAT_PACKAGES_UNAVAILABLE:
    'CellChat is unavailable in the current analysis runtime. Ask an operator to enable the required package profile.',
  CELLCHAT_GROUPING_UNAVAILABLE:
    'CellChat needs valid clustering or identity labels. Run clustering or choose current identities and try again.',
  CELLCHAT_GROUP_COUNT_INVALID:
    'CellChat needs between two and 32 populated groups. Review the selected grouping and try again.',
  CELLCHAT_MIN_GROUP_CELLS:
    'At least two groups must meet the minimum cell threshold. Lower the threshold or revise the grouping.',
  CELLCHAT_ASSAY_UNAVAILABLE: 'CellChat requires an RNA assay in the saved analysis.',
  CELLCHAT_NORMALIZED_DATA_REQUIRED:
    'CellChat requires normalized RNA data. Run normalization and try again.',
  CELLCHAT_DATABASE_OVERLAP_LOW:
    'Too few signaling genes overlap the selected CellChat database. Check the species and RNA assay.',
  CELLCHAT_NO_ELIGIBLE_INTERACTIONS:
    'No eligible ligand-receptor pairs remain for this input and database. No communication result was calculated.',
  CELLCHAT_INPUT_INVALID:
    'CellChat could not construct a valid input. Review the grouping, assay, species, and saved analysis.',
  ENRICHMENT_PACKAGES_UNAVAILABLE:
    'Pathway enrichment is unavailable in the current compute profile. Ask an operator to install the approved enrichment package profile.',
});

const R_COMPLETION_PUBLICATION_INDETERMINATE = 'R_COMPLETION_PUBLICATION_INDETERMINATE';

function codedHandlerError(code, message) {
  const err = new Error(message);
  err.code = code;
  Object.defineProperty(err, 'publicSafeHandlerError', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return err;
}

function safeDiagnosticCode(error) {
  if (!error || typeof error.code !== 'string') return 'UNCLASSIFIED';
  return error.code.replace(/[^A-Z0-9_:-]/gi, '').slice(0, 80) || 'UNCLASSIFIED';
}

function isIndeterminateRExecutionFailure(error) {
  // Once a receipt-backed R request has been marked for dispatch, no response-side
  // failure proves that synchronous R work stopped. This includes oversized or
  // malformed responses and non-200 statuses, not only timeouts/disconnects.
  return (
    !!error &&
    (error.rSideEffectsPossible === true ||
      error.code === 'R_TIMEOUT' ||
      error.code === 'R_UNREACHABLE' ||
      error.code === R_COMPLETION_PUBLICATION_INDETERMINATE)
  );
}

function publicationIndeterminateError(error) {
  if (error && (error.code === 'CLAIM_LOST' || error.code === 'JOB_NOT_FOUND')) return error;
  return codedHandlerError(
    R_COMPLETION_PUBLICATION_INDETERMINATE,
    'Completion publication outcome is indeterminate.'
  );
}

module.exports = {
  SAFE_HANDLER_DOMAIN_MESSAGES,
  R_COMPLETION_PUBLICATION_INDETERMINATE,
  codedHandlerError,
  safeDiagnosticCode,
  isIndeterminateRExecutionFailure,
  publicationIndeterminateError,
};
