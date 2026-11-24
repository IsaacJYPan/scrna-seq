import React, { createContext, useContext } from 'react';

// Which project a figure saved from any plot page belongs to, and whether the
// signed-in person may add figures to it. Plot pages render the figure editor
// without knowing about projects; the editor reads this context instead.
const FigureProjectContext = createContext({
  projectId: null,
  projectName: '',
  canWrite: false,
  collections: [],
  notifySaved: () => {},
});

export const FIGURE_WRITE_ROLES = ['owner', 'admin', 'analyst'];

export function FigureProjectProvider({ value, children }) {
  return <FigureProjectContext.Provider value={value}>{children}</FigureProjectContext.Provider>;
}

export function useFigureProject() {
  return useContext(FigureProjectContext);
}

// Parse a comma-separated tag field into distinct trimmed tags.
export function parseTags(text) {
  const tags = [];
  for (const raw of String(text || '').split(',')) {
    const tag = raw.trim().replace(/\s+/g, ' ');
    if (tag && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  return tags.slice(0, 20);
}

// The editor state saved with a figure, restored when it is edited again.
export function editorStateFromParams(params = {}) {
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    title: params.title || '',
    subtitle: params.subtitle || '',
    xLabel: params.x_label || '',
    yLabel: params.y_label || '',
    ptSize: number(params.pt_size, 1),
    alpha: number(params.alpha, 1),
    doLabel: params.label !== false,
    labelSize: number(params.label_size, 4),
    repel: params.repel !== false,
    legendPos: params.legend_position || 'right',
    fontSize: number(params.font_size, 12),
    palette: params.color_palette || 'Set2',
    dotScale: number(params.dot_scale, 6),
    logScale: params.log_scale === true,
    dpi: number(params.dpi, 300),
    format: ['png', 'pdf', 'svg'].includes(params.format) ? params.format : 'png',
    width: number(params.width, 8),
    height: number(params.height, 6),
    splitBy: params.split_by || '',
    ncol: params.ncol ? String(params.ncol) : '',
  };
}
