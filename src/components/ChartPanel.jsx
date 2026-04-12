import React, { useRef, useEffect } from 'react';

function Histogram({ histData }) {
  if (!histData || !histData.counts) return null;

  const maxCount = Math.max(...histData.counts);

  return (
    <div className="chart-container">
      <div className="histogram-chart">
        {histData.counts.map((count, i) => (
          <div
            key={i}
            className="histogram-bar"
            style={{ height: maxCount > 0 ? `${(count / maxCount) * 100}%` : '0%' }}
          >
            <span className="bar-label">{count}</span>
          </div>
        ))}
      </div>
      <div className="chart-axis">
        <span>{histData.breaks?.[0]?.toFixed(1)}</span>
        <span>{histData.column}</span>
        <span>{histData.breaks?.[histData.breaks.length - 1]?.toFixed(1)}</span>
      </div>
    </div>
  );
}

function ScatterPlot({ scatterData, regression }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!scatterData || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    const w = rect.width;
    const h = rect.height;

    // Clear
    ctx.fillStyle = '#161922';
    ctx.fillRect(0, 0, w, h);

    const { x, y } = scatterData;
    if (!x || !y || x.length === 0) return;

    const pad = 40;
    const xMin = Math.min(...x), xMax = Math.max(...x);
    const yMin = Math.min(...y), yMax = Math.max(...y);
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;

    const toCanvasX = v => pad + ((v - xMin) / xRange) * (w - pad * 2);
    const toCanvasY = v => h - pad - ((v - yMin) / yRange) * (h - pad * 2);

    // Grid lines
    ctx.strokeStyle = '#2a2d3e';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const gy = pad + (i / 4) * (h - pad * 2);
      ctx.beginPath();
      ctx.moveTo(pad, gy);
      ctx.lineTo(w - pad, gy);
      ctx.stroke();
    }

    // Points
    ctx.fillStyle = 'rgba(108, 99, 255, 0.6)';
    x.forEach((xv, i) => {
      const cx = toCanvasX(xv);
      const cy = toCanvasY(y[i]);
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    });

    // Regression line
    if (regression?.coefficients) {
      const coeffs = Object.values(regression.coefficients);
      if (coeffs.length >= 2) {
        const intercept = coeffs[0];
        const slope = coeffs[1];
        ctx.strokeStyle = '#00d4aa';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(toCanvasX(xMin), toCanvasY(intercept + slope * xMin));
        ctx.lineTo(toCanvasX(xMax), toCanvasY(intercept + slope * xMax));
        ctx.stroke();
      }
    }

    // Axis labels
    ctx.fillStyle = '#5a5e72';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(xMin.toFixed(0), toCanvasX(xMin), h - 10);
    ctx.fillText(xMax.toFixed(0), toCanvasX(xMax), h - 10);
    ctx.textAlign = 'right';
    ctx.fillText(yMin.toFixed(0), pad - 8, toCanvasY(yMin) + 4);
    ctx.fillText(yMax.toFixed(0), pad - 8, toCanvasY(yMax) + 4);
  }, [scatterData, regression]);

  return (
    <div className="scatter-wrap">
      <canvas ref={canvasRef} />
    </div>
  );
}

export default function ChartPanel({ histData, regressionData }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {regressionData && (
        <>
          <div className="regression-results">
            <div className="regression-metric">
              <div className="metric-label">R²</div>
              <div className="metric-value">{regressionData.r_squared}</div>
            </div>
            <div className="regression-metric">
              <div className="metric-label">Adj R²</div>
              <div className="metric-value">{regressionData.adj_r_squared}</div>
            </div>
            <div className="regression-metric">
              <div className="metric-label">Std Error</div>
              <div className="metric-value">{regressionData.residual_std_error}</div>
            </div>
            <div className="regression-metric">
              <div className="metric-label">F-Statistic</div>
              <div className="metric-value">{regressionData.f_statistic}</div>
            </div>
            <div className="regression-metric">
              <div className="metric-label">P-Value</div>
              <div className="metric-value">{regressionData.p_value}</div>
            </div>
          </div>
          {regressionData.scatter_data && (
            <ScatterPlot
              scatterData={regressionData.scatter_data}
              regression={regressionData}
            />
          )}
        </>
      )}
      {histData && <Histogram histData={histData} />}
    </div>
  );
}
