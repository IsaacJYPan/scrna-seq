import React from 'react';

// The product mark: three analysis states joined by one trace.
export default function TraceMark({ size = 24, className = '' }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
    <path d="M5 18.5 C 9 18.5, 8 5.5, 12 5.5 S 15 18.5, 19 18.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
    <circle cx="5" cy="18.5" r="2.4" fill="currentColor" />
    <circle cx="12" cy="5.5" r="2.4" fill="currentColor" />
    <circle cx="19" cy="18.5" r="2.4" fill="var(--color-trace)" />
  </svg>;
}
