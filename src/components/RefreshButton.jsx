import React from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

// Small icon-only reload control placed next to the data it reloads, rather
// than a labelled button in a page's main action slot.
export default function RefreshButton({ onClick, disabled = false, loading = false, label = 'Refresh', className = '' }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}
      className={`refresh-button ${className}`}>
      {loading ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
    </button>
  );
}
