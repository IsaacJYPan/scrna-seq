import React from 'react';

export default function DataTable({ data, columns }) {
  if (!data || data.length === 0) return null;

  // Detect numeric columns for mono styling
  const numericCols = new Set();
  columns.forEach(col => {
    if (data[0] && typeof data[0][col] === 'number') {
      numericCols.add(col);
    }
  });

  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            {columns.map(col => (
              <th key={col}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i}>
              <td className="num-cell">{i + 1}</td>
              {columns.map(col => (
                <td key={col} className={numericCols.has(col) ? 'num-cell' : ''}>
                  {row[col] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
