import React from 'react';

export default function StatsPanel({ stats }) {
  if (!stats || stats.length === 0) return null;

  return (
    <div className="stats-grid">
      {stats.map(s => (
        <div className="stat-card" key={s.column}>
          <div className="stat-title">{s.column}</div>
          <div className="stat-row">
            <span className="label">Min</span>
            <span className="value">{s.min}</span>
          </div>
          <div className="stat-row">
            <span className="label">Q1</span>
            <span className="value">{s.q1}</span>
          </div>
          <div className="stat-row">
            <span className="label">Median</span>
            <span className="value">{s.median}</span>
          </div>
          <div className="stat-row">
            <span className="label">Mean</span>
            <span className="value">{s.mean}</span>
          </div>
          <div className="stat-row">
            <span className="label">Q3</span>
            <span className="value">{s.q3}</span>
          </div>
          <div className="stat-row">
            <span className="label">Max</span>
            <span className="value">{s.max}</span>
          </div>
          <div className="stat-row">
            <span className="label">Std Dev</span>
            <span className="value">{s.sd}</span>
          </div>
          <div className="stat-row">
            <span className="label">Count</span>
            <span className="value">{s.n}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
