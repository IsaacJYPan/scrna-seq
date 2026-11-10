// An agent's sandbox run as notebook cells, in the app's notebook format.
//
// Each step of the script (see readableR.mjs) becomes a Markdown cell with the
// step's title and leading comments, followed by an R code cell. The code is
// the readable version (error handling hidden) unless `exact` is set; either
// way the run's exact script SHA-256 is recorded so the source of truth stays
// identifiable. Output files are attached to the step whose code names them.

import { readableSteps } from './readableR.mjs';
import { NOTEBOOK_DOCUMENT_SCHEMA, NOTEBOOK_DOCUMENT_LIMITS } from './notebookDocument.mjs';

// Leading comment lines of a step become its explanation text.
function splitComments(code) {
  const lines = code.split('\n');
  const text = [];
  let index = 0;
  while (index < lines.length && /^\s*#/.test(lines[index])) {
    text.push(lines[index].replace(/^\s*#+'?\s?/, ''));
    index += 1;
  }
  return { text: text.join('\n').trim(), code: lines.slice(index).join('\n').replace(/^\s*\n/, '') };
}

function outputsFor(code, files, claimed) {
  return files.filter((file) => !claimed.has(file.name) && code.includes(file.name.split('/').pop()));
}

// Returns [{ kind: 'markdown' | 'code', id, source, step?, outputs? }].
export function agentRunCells(run, { exact = false } = {}) {
  const steps = Array.isArray(run?.steps) ? run.steps : readableSteps(run?.script || '');
  const files = Array.isArray(run?.files) ? run.files : [];
  const claimed = new Set();
  const cells = [];
  steps.forEach((step) => {
    const source = exact ? step.code : step.readable;
    const { text, code } = splitComments(source || '');
    cells.push({ kind: 'markdown', id: `step-${step.number}-text`, step: step.number,
      source: `## ${step.number}. ${step.title}${text ? `\n\n${text}` : ''}` });
    const outputs = outputsFor(step.code, files, claimed);
    for (const file of outputs) claimed.add(file.name);
    cells.push({ kind: 'code', id: `step-${step.number}-code`, step: step.number, source: code || '# (only error handling)',
      hiddenLines: exact ? 0 : step.hiddenLines || 0, outputs });
  });
  const rest = files.filter((file) => !claimed.has(file.name));
  if (rest.length && cells.length) cells[cells.length - 1].outputs = [...cells[cells.length - 1].outputs, ...rest];
  return cells;
}

// Notebook document content for saving the run into a project analysis.
export function agentRunNotebookContent(run, { exact = false } = {}) {
  const intro = [
    `# Agent run ${run.runNumber}: ${run.title}`,
    '',
    `Written and run by ${run.agent?.displayName || 'an agent'} in the sandbox "${run.sandboxName || run.sandboxId}". `
      + `${exact ? 'Exact code as it ran.' : 'Error handling is hidden for reading; the exact code is in the run record.'}`,
    '',
    `Run \`${run.id}\` · script SHA-256 \`${run.scriptSha256}\``,
  ].join('\n');
  const cells = [{ id: 'intro', type: 'markdown', source: intro, metadata: {}, collapsed: false }];
  for (const cell of agentRunCells(run, { exact })) {
    const metadata = { traceomics: { agentRun: run.id, step: cell.step } };
    if (cell.kind === 'markdown') {
      cells.push({ id: cell.id, type: 'markdown', source: cell.source, metadata, collapsed: false });
    } else {
      cells.push({ id: cell.id, type: 'code', language: 'R', source: cell.source, metadata, collapsed: false });
      if (cell.outputs.length) {
        cells.push({ id: `${cell.id}-outputs`, type: 'markdown', metadata, collapsed: false,
          source: `Outputs: ${cell.outputs.map((file) => `\`${file.name}\``).join(', ')} (draft files of run \`${run.id}\`)` });
      }
    }
  }
  const content = { schema: NOTEBOOK_DOCUMENT_SCHEMA, defaultLanguage: 'R', metadata: {}, cells };
  const title = `Agent run ${run.runNumber}: ${run.title}`;
  return { title: [...title].slice(0, NOTEBOOK_DOCUMENT_LIMITS.title).join(''), content };
}
