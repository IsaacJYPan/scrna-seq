import {
  NOTEBOOK_CELL_ID, NOTEBOOK_DOCUMENT_LIMITS,
  normalizeNotebookContent,
} from './notebookDocument.mjs';
import {
  NOTEBOOK_INTERCHANGE_SCHEMA, NOTEBOOK_INTERCHANGE_LIMITS,
  createNotebookInterchangeBudget, notebookInterchangeBytes, notebookInterchangeError,
  notebookInterchangeText, notebookInterchangeFields, notebookInterchangeArray,
  notebookInterchangeFilename, notebookMultilineText, normalizeNotebookInterchange,
  normalizeNotebookImportedCell, normalizeNotebookInterchangeContent,
  notebookMimePreview,
} from './notebookInterchangeFields.mjs';

export { NOTEBOOK_INTERCHANGE_SCHEMA, NOTEBOOK_INTERCHANGE_LIMITS } from './notebookInterchangeFields.mjs';
const own = (value, key) => Object.hasOwn(value, key);
const codeLanguages = new Set(['R', 'python']);
const mimeTypes = new Set(['text/plain', 'application/json', 'image/png', 'image/jpeg']);
const clone = value => JSON.parse(JSON.stringify(value));
const warning = (code, message, extra = {}) => ({ code, message, ...extra });
const fail = notebookInterchangeError;
/** Validate v2 without changing v1 normalization, hashes or saved requests. */
export function normalizeInterchangeNotebookContent(input) {
  return normalizeNotebookInterchangeContent(input, normalizeNotebookContent);
}

function languageName(value) {
  if (typeof value !== 'string') return null;
  if (/^(r|ir|irkernel)$/i.test(value.trim())) return 'R';
  if (/^(python(?:\s*\d+(?:\.\d+)*)?|ipython(?:\d+)?)$/i.test(value.trim())) return 'python';
  return null;
}
function declaredLanguages(metadata) {
  const declared = [languageName(metadata.language_info?.name), languageName(metadata.kernelspec?.language)].filter(Boolean);
  if (!declared.length) {
    const kernel = languageName(metadata.kernelspec?.name);
    if (kernel) declared.push(kernel);
  }
  return declared;
}
function languageFor(metadata, explicit, codeCount, warnings) {
  if (explicit !== undefined && !codeLanguages.has(explicit)) fail('Choose R or python as the notebook editing language.');
  const declared=declaredLanguages(metadata);
  const languages = new Set(declared);
  if (explicit) {
    if (languages.size !== 1 || !languages.has(explicit)) warnings.push(warning('EDITING_LANGUAGE_SELECTED',
      'The selected editing language does not replace the retained notebook kernel or language metadata. No code is executed or converted.'));
    return explicit;
  }
  if (languages.size === 1) return declared[0];
  if (!codeCount) return 'R';
  fail('Choose R or python for source editing because the notebook language is missing, unsupported or inconsistent. Original kernel metadata will be retained.', false, 'NOTEBOOK_LANGUAGE_REQUIRED');
}
function cellLanguage(metadata, fallback) {
  return languageName(metadata.vscode?.languageId) || fallback;
}
function summarize(content, warnings) {
  let outputs = 0, attachments = 0, unsupportedOutputs = 0;
  for (const cell of content.cells) {
    const imported = cell.imported;
    for (const [index, output] of (imported?.outputs || []).entries()) {
      outputs++;
      if (output.data && Object.keys(output.data).some(mime => !mimeTypes.has(mime))) {
        unsupportedOutputs++;
        warnings.push(warning('UNSUPPORTED_MIME_RETAINED',
          'This imported output contains a rich representation that is retained for export but must not execute or load embedded resources.',
          { cellId: cell.id, outputIndex: index }));
      }
      if(output.data && (own(output.data,'image/png')||own(output.data,'image/jpeg')) && notebookMimePreview(output.data).family!=='image') {
        warnings.push(warning('RASTER_PREVIEW_UNAVAILABLE','Imported raster bytes are retained, but a bounded valid raster preview is unavailable.',{cellId:cell.id,outputIndex:index}));
      }
    }
    for (const bundle of Object.values(imported?.attachments || {})) {
      attachments++;
      if (Object.keys(bundle).some(mime => !['image/png', 'image/jpeg'].includes(mime))) {
        warnings.push(warning('ATTACHMENT_MIME_RETAINED',
          'This attachment contains a representation without a supported raster preview. Its data remains inert and retained for export.', { cellId: cell.id }));
      }
    }
  }
  return { cells: content.cells.length, codeCells: content.cells.filter(cell => cell.type === 'code').length,
    markdownCells: content.cells.filter(cell => cell.type === 'markdown').length,
    rawCells: content.cells.filter(cell => cell.type === 'raw').length,
    outputs, attachments, unsupportedOutputs, defaultLanguage: content.defaultLanguage };
}

function parseNotebookSource(source) {
  // Native JSON.parse would silently discard duplicate keys and round integer
  // literals outside JavaScript's exact range. Reject those before decoding.
  let offset = 0;
  const malformed = () => fail('The selected .ipynb file must contain valid JSON. The original file and document remain unchanged.');
  const whitespace = () => { while (offset < source.length && /[\t\n\r ]/.test(source[offset])) offset++; };
  const string = () => {
    if(source[offset]!=='"')malformed();const start=offset++;
    while(offset<source.length){const character=source[offset++];if(character==='\\')offset++;else if(character==='"')return source.slice(start,offset);}
    return malformed();
  };
  const value = depth => {
    if(depth>32)fail('Notebook JSON exceeds 32 structural nesting levels.');
    whitespace();const character=source[offset];
    if(character==='{'){
      offset++;whitespace();if(source[offset]==='}'){offset++;return;}
      const keys=new Set();
      while(offset<source.length){whitespace();const key=JSON.parse(string());if(keys.has(key))fail('Notebook JSON contains duplicate object keys; importing it would discard data.');keys.add(key);whitespace();if(source[offset++]!==':')malformed();value(depth+1);whitespace();const end=source[offset++];if(end==='}')return;if(end!==',')malformed();}
      malformed();
    }else if(character==='['){
      offset++;whitespace();if(source[offset]===']'){offset++;return;}
      while(offset<source.length){value(depth+1);whitespace();const end=source[offset++];if(end===']')return;if(end!==',')malformed();}
      malformed();
    }else if(character==='"')string();
    else{
      const start=offset;while(offset<source.length&&!/[\t\n\r ,}\]]/.test(source[offset]))offset++;
      const token=source.slice(start,offset);
      if(['true','false','null'].includes(token))return;
      if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token))malformed();
      if(!Number.isFinite(Number(token)))fail('Notebook JSON must contain finite numeric values.');
      if(Number(token)===0&&/[1-9]/.test(token.split(/[eE]/)[0]))fail('A notebook numeric value is too small for the supported precision. Encode it as a string in the original tool to retain it exactly.');
      if(/^-?\d+$/.test(token)&&!Number.isSafeInteger(Number(token)))fail('Notebook JSON contains an integer outside the exact supported numeric range. Encode identifiers as strings in the original tool.');
    }
  };
  try{value(0);whitespace();if(offset!==source.length)malformed();return JSON.parse(source);}
  catch(error){if(error?.code==='INVALID_NOTEBOOK_INTERCHANGE')throw error;return malformed();}
}

/** Read text already decoded as UTF-8 by the caller; never execute notebook data. */
export function importNotebookFile(input = {}, idFactory = () => globalThis.crypto.randomUUID()) {
  notebookInterchangeFields(input,['filename','source','language'],'Notebook import',['filename','source']);
  const {filename,source,language}=input;
  notebookInterchangeFilename(filename);
  notebookInterchangeText(source, 'Notebook file', NOTEBOOK_INTERCHANGE_LIMITS.fileBytes);
  if (notebookInterchangeBytes(source) > NOTEBOOK_INTERCHANGE_LIMITS.fileBytes) fail('Notebook files must contain at most 2 MiB of UTF-8 JSON.', true);
  const notebook = parseNotebookSource(source.startsWith('\uFEFF') ? source.slice(1) : source);
  notebookInterchangeFields(notebook, ['metadata', 'nbformat', 'nbformat_minor', 'cells'], 'Notebook file', ['metadata', 'nbformat', 'nbformat_minor', 'cells']);
  if (notebook.nbformat !== 4 || !Number.isSafeInteger(notebook.nbformat_minor)
      || notebook.nbformat_minor < 0 || notebook.nbformat_minor > 5) {
    fail('Supported .ipynb versions are nbformat 4.0 through 4.5. Export a version 4 notebook from its original tool and try again.');
  }
  if (!Array.isArray(notebook.cells) || notebook.cells.length > NOTEBOOK_DOCUMENT_LIMITS.cells) fail('A notebook must contain at most 2000 cells.', Array.isArray(notebook.cells));
  notebookInterchangeArray(notebook.cells, 'Notebook cells');
  const warnings = [];
  const budget = createNotebookInterchangeBudget();
  const interchange = normalizeNotebookInterchange({ filename, nbformatMinor: notebook.nbformat_minor, metadata: notebook.metadata }, budget);
  const count = notebook.cells.filter(cell => cell?.cell_type === 'code').length;
  const defaultLanguage = languageFor(interchange.metadata, language, count, warnings);
  const ids = new Set();
  for (const cell of notebook.cells) {
    notebookInterchangeFields(cell, ['id', 'cell_type', 'metadata', 'source', 'outputs', 'execution_count', 'attachments'],
      'Notebook file cell', ['cell_type', 'metadata', 'source']);
    if (own(cell, 'id')) {
      if (typeof cell.id !== 'string' || !NOTEBOOK_CELL_ID.test(cell.id) || ids.has(cell.id)) fail('Notebook cell IDs must be valid and unique. The original file remains unchanged.');
      ids.add(cell.id);
    } else if (notebook.nbformat_minor >= 5) fail('A nbformat 4.5 notebook requires a stable ID on every cell.');
  }
  if (typeof idFactory !== 'function') fail('Missing legacy cell IDs require an ID generator.');
  const cells = notebook.cells.map((cell, index) => {
    if (!['code', 'markdown', 'raw'].includes(cell.cell_type)) fail('Supported notebook cell types are code, Markdown and raw text.');
    const code = cell.cell_type === 'code';
    if (code ? own(cell, 'attachments') || !own(cell, 'outputs') || !own(cell, 'execution_count')
      : own(cell, 'outputs') || own(cell, 'execution_count')) fail('Notebook cell fields do not match its declared cell type.');
    let id = cell.id;
    if (id === undefined) {
      id = idFactory(index);
      if (typeof id !== 'string' || !NOTEBOOK_CELL_ID.test(id) || ids.has(id)) fail('Generated notebook cell IDs must be valid and unique.');
      ids.add(id);
      warnings.push(warning('LEGACY_CELL_ID_ASSIGNED', 'A stable ID was assigned to this legacy notebook cell and will be retained in saved source and export.', { cellId: id }));
    }
    const imported = normalizeNotebookImportedCell({ metadata: cell.metadata,
      ...(code ? { outputs: cell.outputs, executionCount: cell.execution_count }
        : own(cell, 'attachments') ? { attachments: cell.attachments } : {}) }, { type: cell.cell_type, budget });
    return { id, type: cell.cell_type, ...(code ? { language: cellLanguage(imported.metadata, defaultLanguage) } : {}),
      source: notebookMultilineText(cell.source, 'Cell source'), metadata: {}, collapsed: false, imported };
  });
  const content = normalizeInterchangeNotebookContent({ schema: NOTEBOOK_INTERCHANGE_SCHEMA,
    defaultLanguage, cells, metadata: {}, interchange });
  const summary = summarize(content, warnings);
  if (summary.outputs) warnings.unshift(warning('IMPORTED_HISTORICAL_OUTPUTS',
    'Retained outputs and execution counts came from the imported file. They do not prove a captured in-app run or match later source edits.'));
  return { filename, title: [...filename.replace(/\.ipynb$/i, '').trim() || 'Notebook'].slice(0, NOTEBOOK_DOCUMENT_LIMITS.title).join(''),
    content, warnings, summary };
}

function defaultKernel(language) {
  return language === 'R' ? { name: 'ir', display_name: 'R', language: 'R' }
    : { name: 'python3', display_name: 'Python 3', language: 'python' };
}
function exportCell(cell, defaultLanguage, warnings) {
  const metadata = clone(cell.imported?.metadata || cell.metadata);
  if (cell.type === 'code' && cell.language !== defaultLanguage) {
    if (!own(metadata, 'vscode')) metadata.vscode = { languageId: cell.language };
    else if (metadata.vscode && typeof metadata.vscode === 'object' && !Array.isArray(metadata.vscode)
        && !own(metadata.vscode, 'languageId')) metadata.vscode = { ...metadata.vscode, languageId: cell.language };
    else if (languageName(metadata.vscode?.languageId) !== cell.language) warnings.push(warning('CELL_LANGUAGE_HINT_CONFLICT',
      'An existing cell language hint was preserved. This file does not assign an execution kernel independently to each cell.', { cellId: cell.id }));
  }
  const result = { id: cell.id, cell_type: cell.type, metadata, source: cell.source };
  if (cell.type === 'code') return { ...result, execution_count: cell.imported?.executionCount ?? null, outputs: clone(cell.imported?.outputs || []) };
  return { ...result, ...(cell.imported && own(cell.imported, 'attachments') ? { attachments: clone(cell.imported.attachments) } : {}) };
}

/** Export ordinary nbformat 4.5 JSON. No application execution records are invented. */
export function exportNotebookFile(input, options = {}) {
  notebookInterchangeFields(options,['filename'],'Notebook export options');
  const {filename}=options;
  const imported = input?.schema === NOTEBOOK_INTERCHANGE_SCHEMA;
  const content = imported ? normalizeInterchangeNotebookContent(input) : normalizeNotebookContent(input);
  const name = notebookInterchangeFilename(filename ?? content.interchange?.filename ?? 'notebook.ipynb');
  const warnings = [];
  const metadata = clone(imported ? content.interchange.metadata : content.metadata);
  // For newly authored documents, provide conventional declared editing metadata.
  // An imported notebook retains its exact original metadata, including absence.
  if (!imported) {
    if (!own(metadata, 'kernelspec')) metadata.kernelspec = defaultKernel(content.defaultLanguage);
    if (!own(metadata, 'language_info')) metadata.language_info = { name: content.defaultLanguage === 'R' ? 'R' : 'python' };
    normalizeNotebookInterchange({ filename: name, nbformatMinor: 5, metadata });
  }
  const languages = new Set(content.cells.filter(cell => cell.type === 'code').map(cell => cell.language));
  const declared=new Set(declaredLanguages(metadata)),kernelLanguage=declared.size===1?[...declared][0]:null;
  if (languages.size > 1 || kernelLanguage && [...languages].some(language=>language!==kernelLanguage)) warnings.push(warning('MIXED_CELL_LANGUAGES',
    'Jupyter declares one notebook kernel. Cell language hints do not assign independent kernels; export does not rewrite source or make cross-language cells run automatically.'));
  if(!kernelLanguage&&languages.size)warnings.push(warning('KERNEL_METADATA_UNCHANGED',
    'Original notebook kernel and language metadata are retained. Check the kernel in Jupyter; an editing language does not prove runtime compatibility.'));
  const cells = content.cells.map(cell => exportCell(cell, kernelLanguage, warnings));
  const budget = createNotebookInterchangeBudget();
  for(const cell of cells)normalizeNotebookImportedCell({metadata:cell.metadata,
    ...(cell.cell_type==='code'?{outputs:cell.outputs,executionCount:cell.execution_count}:own(cell,'attachments')?{attachments:cell.attachments}:{})},
  {type:cell.cell_type,budget});
  if(imported && (Object.keys(content.metadata).length || content.cells.some(cell=>Object.keys(cell.metadata).length))) {
    warnings.push(warning('APPLICATION_METADATA_NOT_EXPORTED','Application-only metadata is separate from the original notebook metadata and is not included in this conventional notebook file.'));
  }
  if (content.cells.some(cell => cell.imported?.outputs?.length)) warnings.push(warning('IMPORTED_HISTORICAL_OUTPUTS',
    'Exported outputs and execution counts are historical imported data. They are not a captured in-app execution and may differ from current source.'));
  const notebook={ nbformat: 4, nbformat_minor: 5, metadata, cells };
  const serialize=spacing=>JSON.stringify(notebook,null,spacing).replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,token=>
    /^-?\d+$/.test(token)&&!Number.isSafeInteger(Number(token))?Number(token).toExponential():token)+'\n';
  let text=serialize(2);
  if(notebookInterchangeBytes(text)>NOTEBOOK_INTERCHANGE_LIMITS.fileBytes)text=serialize();
  if(notebookInterchangeBytes(text)>NOTEBOOK_INTERCHANGE_LIMITS.fileBytes)fail('Exported notebook exceeds the 2 MiB file limit.',true);
  return { filename: name, mimeType: 'application/x-ipynb+json', text, warnings };
}
