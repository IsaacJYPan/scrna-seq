import React from 'react';
import EvidenceIntake from './EvidenceIntake';

// Preserve the local-only entry point and its original closed HTTP contract.
export default function LocalEvidenceIntake(props) {
  return <EvidenceIntake {...props} legacyLocal />;
}
