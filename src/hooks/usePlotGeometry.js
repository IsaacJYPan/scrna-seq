import { useCallback, useEffect, useRef, useState } from 'react';

// Measure the chart's actual container, including sidebar and tab-layout changes.
// Ignore hidden cached tabs; their last usable width is kept until they reopen.
export function usePlotGeometry() {
  const [width, setWidth] = useState(600);
  const [element, setElement] = useState(null);
  const observerRef = useRef(null);
  const ref = useCallback(node => setElement(node), []);
  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth(previous => previous === next ? previous : next);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      observerRef.current = new ResizeObserver(measure);
      observerRef.current.observe(element);
    } else window.addEventListener('resize', measure);
    return () => {
      observerRef.current?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [element]);
  return { ref, width, compact: width < 480 };
}

// Rotation follows label density rather than a fixed angle for every dataset.
export function categoryTickAngle(labels = [], width = 600) {
  const values = Array.isArray(labels) ? labels : labels == null ? [] : [labels];
  const length = Math.max(1, ...values.map(label => String(label).length));
  return values.length * (length * 7 + 18) > width ? -45 : 0;
}

export function categoryPlotWidth(genes = [], clusters = []) {
  const symbols = Array.isArray(genes) ? genes : [genes];
  const groups = Array.isArray(clusters) ? clusters : [clusters];
  const labelWidth = Math.min(180, Math.max(0, ...symbols.map(gene => String(gene).length * 7)));
  return Math.max(240, labelWidth + groups.length * 30 + 110);
}
