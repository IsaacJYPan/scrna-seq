import React from 'react';
import { Link2, Loader2 } from 'lucide-react';

export function ConditionsForm({ conditions, conditionName, setConditionName, busy, onSubmit }) {
  return (
    <form className="card min-w-0 p-4 space-y-3" onSubmit={onSubmit}>
      <h3 className="font-semibold">1. Conditions</h3>
      <div className="flex flex-wrap gap-2">
        {conditions.map((item) => (
          <span
            className="max-w-full break-words rounded-full border border-border bg-background px-3 py-1 text-sm"
            key={item.id}
          >
            {item.name}
          </span>
        ))}
      </div>
      <div className="flex max-w-2xl flex-col sm:flex-row sm:items-end gap-3">
        <label className="block min-w-0 flex-1 space-y-1 text-sm">
          <span>Condition name</span>
          <input
            className="input w-full"
            placeholder="e.g. treated"
            value={conditionName}
            onChange={(event) => setConditionName(event.target.value)}
          />
        </label>
        <button
          className="btn btn-primary w-full sm:w-fit shrink-0"
          disabled={!!busy || !conditionName.trim()}
        >
          {busy === 'condition' && <Loader2 size={14} className="animate-spin" />}Add condition
        </button>
      </div>
    </form>
  );
}

export function BiologicalSamples({
  formId,
  samples,
  conditions,
  sample,
  setSample,
  selectIds,
  busy,
  onSubmit,
}) {
  return (
    <section className="card min-w-0 p-4 space-y-3" aria-labelledby={formId + '-samples-heading'}>
      <h3 id={formId + '-samples-heading'} className="font-semibold">
        2. Biological samples
      </h3>
      <p className="text-sm text-textMuted">
        {samples.length} registered sample{samples.length === 1 ? '' : 's'}. Donor and condition
        assignments define the independent replicates.
      </p>
      {samples.length > 0 && (
        <div
          className="overflow-x-auto rounded border border-border"
          tabIndex={0}
          aria-label="Registered biological samples"
        >
          <table className="w-full min-w-[540px] text-left text-sm">
            <thead className="bg-background text-textMuted">
              <tr>
                <th className="p-3 font-medium">Sample</th>
                <th className="p-3 font-medium">Condition</th>
                <th className="p-3 font-medium">Donor</th>
                <th className="p-3 font-medium">Batch</th>
                <th className="p-3 font-medium">Modality</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {samples.map((item) => (
                <tr key={item.id}>
                  <th scope="row" className="p-3 font-medium break-words">
                    {item.name}
                  </th>
                  <td className="p-3 break-words">
                    {item.conditionName ||
                      conditions.find((condition) => condition.id === item.conditionId)?.name ||
                      'Not assigned'}
                  </td>
                  <td className="p-3 break-words">{item.donorCode || 'Not specified'}</td>
                  <td className="p-3 break-words">{item.batch || 'Not specified'}</td>
                  <td className="p-3">
                    {item.modality === 'spatial'
                      ? 'Spatial (metadata only)'
                      : item.modality === 'scrna'
                        ? 'Single-cell RNA'
                        : 'Not specified'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details open={samples.length === 0}>
        <summary className="cursor-pointer text-sm font-medium">Add a biological sample</summary>
        <div className="mt-3">
          {' '}
          <form className="grid min-w-0 grid-cols-1 sm:grid-cols-2 gap-3" onSubmit={onSubmit}>
            <label className="block space-y-1 text-sm">
              <span>Sample name</span>
              <input
                className="input w-full"
                value={sample.name}
                onChange={(event) => setSample({ ...sample, name: event.target.value })}
              />
            </label>
            <div className="block space-y-1 text-sm">
              <label htmlFor={selectIds.sampleCondition}>Condition</label>
              <select
                id={selectIds.sampleCondition}
                className="input w-full"
                value={sample.conditionId}
                onChange={(event) => setSample({ ...sample, conditionId: event.target.value })}
              >
                <option value="">Select a condition</option>
                {conditions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid min-w-0 grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="block min-w-0 space-y-1 text-sm">
                <span>Donor code</span>
                <input
                  className="input w-full"
                  value={sample.donorCode}
                  onChange={(event) => setSample({ ...sample, donorCode: event.target.value })}
                />
              </label>
              <label className="block min-w-0 space-y-1 text-sm">
                <span>Batch</span>
                <input
                  className="input w-full"
                  value={sample.batch}
                  onChange={(event) => setSample({ ...sample, batch: event.target.value })}
                />
              </label>
            </div>
            <div className="block space-y-1 text-sm">
              <label htmlFor={selectIds.modality}>Modality</label>
              <select
                id={selectIds.modality}
                className="input w-full"
                value={sample.modality}
                onChange={(event) => setSample({ ...sample, modality: event.target.value })}
              >
                <option value="scrna">Single-cell RNA</option>
                <option value="spatial">Spatial (metadata only)</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <button
                className="btn btn-primary text-sm w-full sm:w-fit sm:self-start"
                disabled={!!busy || !sample.name.trim() || !sample.conditionId}
              >
                Add sample
              </button>
            </div>
          </form>
        </div>
      </details>
    </section>
  );
}

export function SampleMappings({
  binding,
  setBinding,
  samples,
  selectIds,
  busy,
  objectId,
  mappingsReady,
  bindings,
  onSubmit,
}) {
  return (
    <form className="card min-w-0 p-4 grid grid-cols-1 sm:grid-cols-2 gap-3" onSubmit={onSubmit}>
      <h3 className="sm:col-span-2 font-semibold flex items-center gap-2">
        <Link2 size={16} />
        3. Map cells to samples
      </h3>
      <div className="block space-y-1 text-sm">
        <label htmlFor={selectIds.boundSample}>Biological sample</label>
        <select
          id={selectIds.boundSample}
          className="input w-full"
          value={binding.sampleId}
          onChange={(event) => setBinding({ ...binding, sampleId: event.target.value })}
        >
          <option value="">Select a sample</option>
          {samples.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({item.conditionName})
            </option>
          ))}
        </select>
      </div>
      <div className="grid min-w-0 grid-cols-1 sm:grid-cols-2 gap-2 sm:col-span-2">
        <label className="block min-w-0 space-y-1 text-sm">
          <span>Cell metadata column</span>
          <input
            className="input w-full"
            value={binding.cellMetadataColumn}
            onChange={(event) => setBinding({ ...binding, cellMetadataColumn: event.target.value })}
          />
        </label>
        <label className="block min-w-0 space-y-1 text-sm">
          <span>Cell metadata value</span>
          <input
            className="input w-full"
            placeholder="Exact value"
            value={binding.cellMetadataValue}
            onChange={(event) => setBinding({ ...binding, cellMetadataValue: event.target.value })}
          />
        </label>
      </div>
      <button
        className="btn btn-primary text-sm w-full sm:w-fit sm:justify-self-start"
        disabled={
          !!busy ||
          !objectId ||
          !binding.sampleId ||
          !binding.cellMetadataColumn.trim() ||
          !binding.cellMetadataValue.trim()
        }
      >
        Bind sample
      </button>
      <div className="sm:col-span-2 space-y-2" aria-label="Current sample mappings">
        <h4 className="text-sm font-medium">Current mappings for this saved version</h4>
        {!mappingsReady ? (
          <p className="text-sm text-textMuted">
            {busy === 'refresh'
              ? 'Loading mappings…'
              : 'Mappings unavailable for this saved version. Refresh to try again.'}
          </p>
        ) : bindings.length === 0 ? (
          <p className="text-sm text-textMuted">No samples mapped yet.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {bindings.map((item) => (
              <li
                key={item.id}
                className="rounded border border-border bg-background px-3 py-2 text-sm break-words"
              >
                <span className="font-medium">{item.sampleName}</span>
                <span className="block text-textMuted">
                  <code>{item.cellMetadataColumn}</code> = {item.cellMetadataValue}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </form>
  );
}

export function ComparisonForm({
  contrast,
  setContrast,
  conditions,
  selectIds,
  busy,
  objectId,
  onSubmit,
}) {
  return (
    <form className="card min-w-0 p-4 grid grid-cols-1 sm:grid-cols-2 gap-3" onSubmit={onSubmit}>
      <h3 className="sm:col-span-2 font-semibold">4. Condition comparison</h3>
      <label className="block space-y-1 text-sm">
        <span>Contrast name</span>
        <input
          className="input w-full"
          value={contrast.name}
          onChange={(event) => setContrast({ ...contrast, name: event.target.value })}
        />
      </label>
      <div className="grid min-w-0 grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="block min-w-0 space-y-1 text-sm">
          <label htmlFor={selectIds.numeratorCondition}>Numerator condition</label>
          <select
            id={selectIds.numeratorCondition}
            className="input w-full"
            value={contrast.numeratorConditionId}
            onChange={(event) =>
              setContrast({ ...contrast, numeratorConditionId: event.target.value })
            }
          >
            <option value="">Select condition</option>
            {conditions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div className="block min-w-0 space-y-1 text-sm">
          <label htmlFor={selectIds.denominatorCondition}>Denominator condition</label>
          <select
            id={selectIds.denominatorCondition}
            className="input w-full"
            value={contrast.denominatorConditionId}
            onChange={(event) =>
              setContrast({ ...contrast, denominatorConditionId: event.target.value })
            }
          >
            <option value="">Select condition</option>
            {conditions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="block space-y-1 text-sm">
        <span>Cell type column</span>
        <input
          className="input w-full"
          value={contrast.cellTypeColumn}
          onChange={(event) => setContrast({ ...contrast, cellTypeColumn: event.target.value })}
        />
      </label>
      <div className="block space-y-1 text-sm">
        <label htmlFor={selectIds.replicationUnit}>Replication unit</label>
        <select
          id={selectIds.replicationUnit}
          className="input w-full"
          value={contrast.unitOfReplication}
          onChange={(event) =>
            setContrast({
              ...contrast,
              unitOfReplication: event.target.value,
              paired: event.target.value === 'donor' ? contrast.paired : false,
            })
          }
        >
          <option value="sample">Independent samples</option>
          <option value="donor">Independent donors</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={contrast.paired}
          disabled={contrast.unitOfReplication !== 'donor'}
          onChange={(event) => setContrast({ ...contrast, paired: event.target.checked })}
        />
        Paired by donor
      </label>
      <p className="sm:col-span-2 rounded border border-border bg-background p-2 text-xs text-textMuted">
        Model: <code>{contrast.paired ? '~ donor + condition' : '~ condition'}</code>. Batch values
        are retained as metadata but are not included in this model.
      </p>
      <button
        className="btn btn-primary text-sm w-full sm:w-fit sm:col-span-2 sm:justify-self-start"
        disabled={
          !!busy ||
          !objectId ||
          !contrast.name.trim() ||
          !contrast.numeratorConditionId ||
          !contrast.denominatorConditionId
        }
      >
        Save comparison design
      </button>
    </form>
  );
}

export function SavedContrasts({ contrasts, canWriteStudyDesign, busy, runContrast }) {
  return (
    <div className="card p-4">
      <h3 className="font-semibold mb-3">Saved contrasts</h3>
      {contrasts.length === 0 ? (
        <p className="text-sm text-slate-400">No contrast snapshots yet.</p>
      ) : (
        <div className="space-y-2">
          {contrasts.map((item) => (
            <div key={item.id} className="rounded border border-border p-3 text-sm">
              <div className="flex justify-between gap-3">
                <strong>{item.name}</strong>
                <span
                  className={`badge ${item.status === 'invalid' ? 'text-red-700 dark:text-red-300' : item.status === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}
                >
                  {item.status}
                </span>
              </div>
              <p className="text-slate-400">
                {item.numeratorConditionName} vs {item.denominatorConditionName} ·{' '}
                {item.unitOfReplication}-level · {item.cellTypeColumn}
              </p>
              <p className="mt-1 text-xs text-textMuted">
                Model:{' '}
                <code>
                  {item.modelFormula || (item.paired ? '~ donor + condition' : '~ condition')}
                </code>
              </p>
              {item.validation?.issues?.map((issue) => (
                <p className="text-red-700 dark:text-red-300 text-xs mt-1" key={issue}>
                  {issue}
                </p>
              ))}
              {item.validation?.warnings?.map((warning) => (
                <p className="text-amber-700 dark:text-amber-300 text-xs mt-1" key={warning}>
                  {warning}
                </p>
              ))}
              <button
                type="button"
                className="btn btn-secondary text-xs mt-2"
                disabled={!canWriteStudyDesign || item.status === 'invalid' || !!busy}
                onClick={() => runContrast(item)}
              >
                Run edgeR pseudobulk
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
