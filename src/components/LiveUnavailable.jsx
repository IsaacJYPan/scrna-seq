import React from 'react';
import { History, Loader2 } from 'lucide-react';

// Shown on analysis steps when the selected saved version is not loaded in the
// person's live R session (for example after the analysis server restarted).
// The step's own prerequisites (PCA and so on) cannot be judged until it is.
export default function LiveUnavailable({ reopening = false, onOpenHistory }) {
  return (
    <div className="h-full flex items-center justify-center p-8 bg-background">
      <div className="text-center max-w-sm">
        {reopening
          ? <Loader2 size={40} className="mx-auto mb-4 animate-spin text-primary" aria-hidden="true" />
          : <History size={40} className="mx-auto mb-4 text-textMuted" aria-hidden="true" />}
        <h2 className="text-xl font-bold text-text mb-2">{reopening ? 'Reopening your saved version' : 'Saved version not open'}</h2>
        <p className="text-textMuted">
          {reopening
            ? 'The analysis server restarted. This takes a moment; the step appears when it is ready.'
            : 'This step needs the saved version loaded in your live session. Open it from Runs & Results.'}
        </p>
        {!reopening && onOpenHistory && (
          <button type="button" className="btn btn-primary mt-4 text-sm" onClick={onOpenHistory}>Open Runs &amp; Results</button>
        )}
      </div>
    </div>
  );
}
