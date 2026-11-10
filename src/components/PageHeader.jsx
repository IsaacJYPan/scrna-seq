import React from 'react';
import { sentenceCase } from '../sentenceCase';

// Peer pages share a hierarchy; actions wrap below the title when their combined
// minimum widths no longer fit, rather than squeezing supporting copy.
export default function PageHeader({ title, description, actions, titleAction, children, className = '' }) {
  return <header className={`page-header ${className}`}>
    <div className="page-header-content">
      <div className="flex items-center gap-2"><h2 className="page-title">{sentenceCase(title)}</h2>{titleAction}</div>
      {description && <p className="page-description">{description}</p>}
      {children}
    </div>
    {actions && <div className="page-header-actions">{actions}</div>}
  </header>;
}
