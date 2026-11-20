import React from 'react';
import { Bot } from 'lucide-react';

// Marks work produced by an agent's own R script (not verified code). It stays
// on the result wherever it appears, with whether a person has reviewed it.
const REVIEW_TEXT = {
  draft: 'Needs review',
  promoted: 'Reviewed and promoted',
  discarded: 'Discarded by reviewer',
};

export function aiAuthorshipLabel(authorship) {
  if (!authorship) return null;
  return `AI-written code · ${REVIEW_TEXT[authorship.reviewState] || 'Review status unknown'}`;
}

export function aiAuthorshipDetail(authorship) {
  if (!authorship) return null;
  const who = authorship.agentName ? `Written by the agent "${authorship.agentName}"` : 'Written by an agent';
  const why = authorship.reason ? ` Reason given for not using verified code: ${authorship.reason}` : '';
  return `${who} in a sandbox, not from a verified workflow or method.${why}`;
}

export default function AiAuthorshipBadge({ authorship, className = '' }) {
  if (!authorship) return null;
  const needsReview = authorship.reviewState !== 'promoted';
  const tone = needsReview
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200'
    : 'border-border bg-background text-textMuted';
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-semibold ${tone} ${className}`}
      title={aiAuthorshipDetail(authorship)}
      data-testid="ai-authorship-badge"
    >
      <Bot size={12} aria-hidden="true" className="shrink-0" />
      <span className="truncate">{aiAuthorshipLabel(authorship)}</span>
    </span>
  );
}
