import React, { useId } from 'react';

const STEPS = [
  { title: 'Input', description: 'Initial detection limits', keys: ['minCells', 'minFeatures'] },
  { title: 'Quality control', description: 'Filter cells before normalization', keys: ['minFeaturesFilter', 'maxFeaturesFilter', 'maxPercentMt'] },
  { title: 'Normalization', description: 'Normalize RNA and select features', keys: ['scaleFactor', 'variableFeatures'] },
  { title: 'PCA', description: 'Calculate principal components', keys: ['pcaDims'] },
  { title: 'Clustering', description: 'Group cells by expression', keys: ['clusterDims', 'clusterResolution'] },
  { title: 'UMAP', description: 'Create the cell embedding', keys: ['umapDims', 'umapNeighbors', 'umapMinDist'] },
];

const LABELS = {
  minCells: 'Min cells per gene', minFeatures: 'Min genes per cell',
  minFeaturesFilter: 'Min detected genes', maxFeaturesFilter: 'Max detected genes',
  maxPercentMt: 'Max mitochondrial RNA (%)', pcaDims: 'PCA components',
  clusterDims: 'PCs for clustering', clusterResolution: 'Resolution',
  umapDims: 'PCs for UMAP', umapNeighbors: 'Neighbors', umapMinDist: 'Minimum distance',
};

export default function SeuratPipelineSettings({ params, setParams, controls }) {
  const id = useId();
  const set = (key, value) => setParams(previous => ({ ...previous, [key]: value }));
  const field = key => {
    const control = controls.find(control => control.key === key);
    if (!control) return null;
    return <label key={key} className="pipeline-parameter">
      <span>{LABELS[key] || control.label}</span>
      <input type="number" min={control.min} max={control.max} step={control.step}
        data-parameter={key} className="input tabular-nums"
        value={params[key]} onChange={event => set(key, event.target.value)} />
    </label>;
  };
  return <div className="pipeline-settings">
    <ol className="divide-y divide-border">
      {STEPS.map((step, index) => <li key={step.title}>
        <section role="group" aria-labelledby={`${id}-${index}`} className="pipeline-step-row">
          <div className="pipeline-step-heading">
            <span className="pipeline-step-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <div><h5 id={`${id}-${index}`} className="font-semibold text-text">{step.title}</h5>
              <p className="mt-1 text-xs leading-relaxed text-textMuted">{step.description}</p></div>
          </div>
          <div className="pipeline-step-fields">
            {step.title === 'Quality control' && <label className="pipeline-qc-toggle">
              <input type="checkbox" checked={params.applyQcFilter} onChange={event => set('applyQcFilter', event.target.checked)} />
              Apply QC filter
            </label>}
            {step.title === 'Quality control' && !params.applyQcFilter
              ? <p className="self-center text-sm text-textMuted">Cell filtering will be skipped.</p>
              : <>
                {step.title === 'Normalization' && <label className="pipeline-parameter">
                  <span>Normalization</span>
                  <select className="input" value={params.normalizationMethod} onChange={event => set('normalizationMethod', event.target.value)}>
                    <option value="LogNormalize">LogNormalize</option><option value="SCTransform">SCTransform</option>
                  </select>
                </label>}
                {step.title === 'UMAP' && <label className="pipeline-parameter">
                  <span>UMAP components</span>
                  <select className="input" value={params.umapComponents} onChange={event => set('umapComponents', Number(event.target.value))}>
                    <option value={2}>2D</option><option value={3}>3D</option>
                  </select>
                </label>}
                {step.keys.filter(key => key !== 'scaleFactor' || params.normalizationMethod === 'LogNormalize').map(field)}
              </>}
          </div>
        </section>
      </li>)}
    </ol>
    <details className="border-t border-border px-4 py-3 sm:px-5">
      <summary className="w-fit cursor-pointer rounded text-sm font-medium text-textMuted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">Reproducibility</summary>
      <label className="pipeline-parameter mt-4 max-w-56">
        <span>Seed (optional)</span>
        <input type="number" min={0} max={2147483647} step={1} className="input tabular-nums"
          value={params.seed ?? ''} onChange={event => set('seed', event.target.value === '' ? null : event.target.value)} />
      </label>
    </details>
  </div>;
}
