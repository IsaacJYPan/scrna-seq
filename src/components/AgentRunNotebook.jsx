import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChevronDown, ChevronRight, Download, Loader2 } from 'lucide-react';
import CodeEditor from '../notebooks/CodeEditor';
import ExactDetails from './ExactDetails';
import { agentRunCells, agentRunNotebookContent } from '../../shared/agentRunNotebook.mjs';
import { listAnalyses } from '../analyses/researchAnalysisApi';
import { createNotebook } from '../notebooks/notebookApi';
import { publicErrorMessage } from '../publicError';

// An agent's sandbox run shown as numbered notebook steps, read-only. Each
// step is one cell: its title and explanation, then its R, then the output
// files that step wrote. "Readable" hides error handling; "Exact code" is what ran. A
// person with write access can save the run as a notebook in an analysis.

const safeUrl = (url) => (/^(https?:|mailto:|#)/i.test(String(url || '')) ? url : '');

function TextOutput({ load }) {
  const [text, setText] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    load().then((t) => { if (live) setText(t); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [load]);
  if (failed) return <p className="text-xs text-textMuted">Preview unavailable.</p>;
  if (text === null) return <Loader2 size={14} className="animate-spin text-textMuted" />;
  const lines = text.split(/\r?\n/);
  return <pre className="max-h-64 overflow-auto whitespace-pre rounded border border-border bg-background p-3 font-mono text-xs text-text">{lines.slice(0, 30).join('\n')}{lines.length > 30 ? '\n…' : ''}</pre>;
}

function CellOutputs({ outputs, fileUrl, readText }) {
  const [open, setOpen] = useState(null);
  if (!outputs?.length) return null;
  return (
    <div aria-label="Cell outputs" className="mt-3 space-y-3 border-t border-border pt-3">
      {outputs.map((file) => (
        <div key={file.name} className="space-y-1">
          {file.kind === 'image' ? (
            <img src={fileUrl(file.name)} alt={file.name} className="h-auto max-h-[32rem] max-w-full rounded border border-border bg-white object-contain" />
          ) : file.kind === 'text' && open === file.name ? (
            <TextOutput load={() => readText(file.name)} />
          ) : null}
          <p className="flex flex-wrap items-center gap-2 text-xs text-textMuted">
            <code className="text-text">{file.name}</code> · draft output
            {file.kind === 'text' && readText && (
              <button type="button" className="text-primary underline" onClick={() => setOpen(open === file.name ? null : file.name)}>{open === file.name ? 'Hide' : 'Show table'}</button>
            )}
            <a className="inline-flex items-center gap-1 text-primary underline" href={fileUrl(file.name, { download: true })}><Download size={12} /> Download</a>
          </p>
        </div>
      ))}
    </div>
  );
}

// agentRunCells gives each step as a Markdown cell ("## n. Title" plus the
// step's leading comments) followed by its code cell; show them as one.
export function stepsFromCells(cells) {
  const steps = [];
  for (const cell of cells) {
    let step = steps.find((entry) => entry.number === cell.step);
    if (!step) { step = { number: cell.step, title: '', text: '', code: null }; steps.push(step); }
    if (cell.kind === 'markdown') {
      const [heading, ...rest] = cell.source.split('\n');
      step.title = heading.replace(/^#+\s*\d+\.\s*/, '');
      step.text = rest.join('\n').trim();
    } else {
      step.code = cell;
    }
  }
  return steps;
}

function StepCell({ step, theme, fileUrl, readText }) {
  const [collapsed, setCollapsed] = useState(false);
  const label = `Step ${step.number}${step.title ? `: ${step.title}` : ''}`;
  const lines = step.code ? step.code.source.split('\n').length : 0;
  return (
    <section aria-label={label} className="min-w-0 rounded-lg border border-border bg-surface/50 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={`${collapsed ? 'Show' : 'Hide'} ${label}`} className="rounded p-1 text-textMuted">
          {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
        </button>
        <span className="font-semibold text-text">{step.number}. {step.title || 'Step'}</span>
        {step.code?.hiddenLines > 0 && <span className="text-xs text-textMuted">{step.code.hiddenLines} line{step.code.hiddenLines === 1 ? '' : 's'} of error handling hidden</span>}
      </div>
      {collapsed ? <p className="mt-1 text-xs text-textMuted">Hidden · {lines} line{lines === 1 ? '' : 's'} of R</p> : (
        <>
          {step.text && <div className="prose prose-sm mt-2 max-w-none text-text"><ReactMarkdown skipHtml urlTransform={safeUrl}>{step.text}</ReactMarkdown></div>}
          {step.code && <div className="mt-3"><CodeEditor key={step.code.source} value={step.code.source} language="R" theme={theme} readOnly label={`R code of ${label}`} /></div>}
          <CellOutputs outputs={step.code?.outputs} fileUrl={fileUrl} readText={readText} />
        </>
      )}
    </section>
  );
}

export default function AgentRunNotebook({ run, projectId, theme = 'light', fileUrl, readText, canSave = false, label }) {
  const [exact, setExact] = useState(false);
  const cells = useMemo(() => agentRunCells(run, { exact }), [run, exact]);
  const steps = useMemo(() => stepsFromCells(cells), [cells]);
  const [saving, setSaving] = useState(null);
  const [analyses, setAnalyses] = useState(null);
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState(null);

  const startSave = async () => {
    setMessage(null);
    setSaving('choose');
    try {
      const result = await listAnalyses(projectId);
      setAnalyses(result.analyses || []);
      setTarget(result.analyses?.[0]?.id || '');
    } catch (error) {
      setMessage({ error: publicErrorMessage(error, 'Analyses could not be loaded.') });
      setSaving(null);
    }
  };
  const save = async () => {
    setSaving('busy');
    try {
      const { title, content } = agentRunNotebookContent(run, { exact });
      await createNotebook(projectId, target, { requestId: crypto.randomUUID(), title, content });
      const name = analyses.find((a) => a.id === target)?.name || 'the analysis';
      setMessage({ ok: `Saved as a notebook in ${name}. Open it from that analysis's documents.` });
      setSaving(null);
    } catch (error) {
      setMessage({ error: publicErrorMessage(error, 'The notebook could not be saved.') });
      setSaving('choose');
    }
  };

  return (
    <div className="space-y-3" aria-label={label || `Notebook for run ${run.runNumber}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-textMuted">
        <span>{steps.length} step{steps.length === 1 ? '' : 's'}</span>
        <span className="flex flex-wrap items-center gap-2">
          <span role="group" aria-label="Code view" className="inline-flex overflow-hidden rounded border border-border">
            <button type="button" aria-pressed={!exact} onClick={() => setExact(false)} className={`px-2 py-1 ${!exact ? 'bg-primary/10 font-bold text-primary' : ''}`}>Readable</button>
            <button type="button" aria-pressed={exact} onClick={() => setExact(true)} className={`border-l border-border px-2 py-1 ${exact ? 'bg-primary/10 font-bold text-primary' : ''}`}>Exact code</button>
          </span>
          {canSave && saving === null && <button type="button" className="btn btn-secondary text-xs" onClick={startSave}>Save as notebook</button>}
        </span>
      </div>
      {saving && analyses && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-xs">
          {analyses.length === 0 ? <span className="text-textMuted">Create an analysis first; notebooks are kept in analyses.</span> : <>
            <label className="text-textMuted">Save to analysis
              <select aria-label="Save to analysis" value={target} onChange={(e) => setTarget(e.target.value)} className="ml-2 rounded border border-border bg-background px-2 py-1 text-text">
                {analyses.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <button type="button" className="btn btn-primary text-xs" disabled={saving === 'busy' || !target} onClick={save}>{saving === 'busy' ? 'Saving…' : 'Save'}</button>
          </>}
          <button type="button" className="btn btn-secondary text-xs" onClick={() => setSaving(null)}>Cancel</button>
        </div>
      )}
      {message?.ok && <p role="status" className="text-xs text-success">{message.ok}</p>}
      {message?.error && <p role="alert" className="text-xs text-danger">{message.error}</p>}
      <div className="space-y-4">
        {steps.map((step) => <StepCell key={`${exact}:${step.number}`} step={step} theme={theme} fileUrl={fileUrl} readText={readText} />)}
      </div>
      {!exact && <p className="text-[11px] text-textMuted">The readable view hides error handling; Exact code shows what ran.
        <ExactDetails className="ml-1" label="Exact script" items={[{ label: 'Script SHA-256', value: run.scriptSha256 }]} /></p>}
    </div>
  );
}
