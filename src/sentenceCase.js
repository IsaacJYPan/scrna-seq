// Interface labels are sentence case. Some labels arrive in title case from
// pipeline contracts shared with the server, so they are converted for
// display here instead of changing the contract values.
const KEEP = new Set(['R', 'PCA', 'UMAP', 'QC', 'DEG', 'GSEA', 'CellChat', 'Seurat', 'Visium', 'Slurm', 'PBMC', 'PBMC3k', 'HDF5', 'SSH', 'API', 'ID', 'AI']);

export function sentenceCase(label) {
  if (typeof label !== 'string') return label;
  return label.split(/(\s+)/).map((word, index) => {
    if (index === 0 || /^\s+$/.test(word)) return word;
    const bare = word.replace(/[^A-Za-z0-9-]/g, '');
    if (KEEP.has(bare) || /^[A-Z0-9-]{2,}$/.test(bare) || /[a-z][A-Z]/.test(bare) || bare.startsWith('scRNA')) return word;
    return /^[A-Z][a-z]/.test(word) ? word[0].toLowerCase() + word.slice(1) : word;
  }).join('');
}
