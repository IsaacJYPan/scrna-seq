import React from 'react';
import { commandOutcome } from './RSessionPanels';

export default function Output({ entry, canPublish, onFigure, onCopy }) {
  const result = entry?.result;
  if (!entry) return null;
  return (
    <section aria-label="R command output" className="space-y-3 rounded border border-border p-3">
      <div className="font-medium">
        Command {entry.order} · {commandOutcome(entry)}
      </div>
      <details>
        <summary className="cursor-pointer text-xs">Executed R source and checksum</summary>
        {entry.kernelId && (
          <div className="text-xs break-all pt-2">
            Kernel {entry.kernelId} · generation {entry.generation || 'Unconfirmed'}
          </div>
        )}
        <pre className="whitespace-pre-wrap overflow-auto max-h-64 text-xs pt-2">
          {entry.source}
        </pre>
        <div className="text-xs break-all font-mono">SHA-256 {entry.sourceSha256}</div>
      </details>
      {typeof entry.source === 'string' && (
        <button className="btn btn-secondary text-xs" onClick={onCopy}>
          Copy executed source to new R cell
        </button>
      )}
      {!entry.completionKnown && (
        <p role="status">
          Completion is unconfirmed. Refresh session status; this command will not be rerun
          automatically.
        </p>
      )}
      {(entry.interrupted || result?.interrupted) && (
        <p role="status">
          R command interrupted. Earlier variables remain, but this command may already have changed
          them. Inspect the session before continuing.
        </p>
      )}
      {result?.stdout && (
        <pre aria-label="R stdout" className="overflow-auto whitespace-pre-wrap text-xs max-h-64">
          {result.stdout}
        </pre>
      )}
      {result?.warnings?.length > 0 && (
        <ul aria-label="R warnings" className="text-sm text-amber-700 dark:text-amber-300">
          {result.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
      {result?.error && (
        <pre role="alert" className="whitespace-pre-wrap text-sm text-red-600 dark:text-red-300">
          {result.error.message}
        </pre>
      )}
      {result?.tables?.map((table, index) => (
        <div key={index} className="overflow-auto">
          <div className="text-sm font-medium">
            {table.name}
            {table.truncated ? ' · preview' : ''}
          </div>
          <table className="text-xs w-full">
            <thead>
              <tr>
                {table.columns.map((column) => (
                  <th className="text-left p-2 border-b border-border" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((value, column) => (
                    <td className="p-2 border-b border-border" key={column}>
                      {value == null ? 'NA' : String(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {result?.figures?.map((figure, index) =>
        figure.mimeType === 'image/png' &&
        typeof figure.data === 'string' &&
        /^[A-Za-z0-9+/=]+$/.test(figure.data) ? (
          <figure key={index}>
            <img
              alt={`R figure ${index + 1}`}
              src={`data:image/png;base64,${figure.data}`}
              className="max-w-full max-h-96 object-contain bg-white"
            />
            <figcaption className="text-xs break-all">PNG SHA-256 {figure.sha256}</figcaption>
            {canPublish && entry.status === 'completed' && entry.completionKnown && (
              <button className="btn btn-secondary text-xs mt-2" onClick={() => onFigure(index)}>
                Save figure {index + 1}
              </button>
            )}
          </figure>
        ) : null
      )}
      {result?.truncated && (
        <p className="text-xs text-textMuted">Output exceeds the console preview limit.</p>
      )}
    </section>
  );
}
