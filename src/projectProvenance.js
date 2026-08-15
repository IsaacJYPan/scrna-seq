export function buildProjectProvenancePayload(provenance, analysisObjectId) {
  if (!provenance || typeof provenance !== 'object' || !analysisObjectId) return null;
  return {
    analysisObjectId,
    timestamp: provenance.timestamp,
    language: provenance.language,
    languageVersion: provenance.languageVersion,
    packages: Array.isArray(provenance.packages) ? provenance.packages : [],
    script: typeof provenance.script === 'string' ? provenance.script : '',
    parameters: provenance.parameters && typeof provenance.parameters === 'object'
      && !Array.isArray(provenance.parameters) ? provenance.parameters : {},
    operation: typeof provenance.operation === 'string' ? provenance.operation : 'unknown',
  };
}
