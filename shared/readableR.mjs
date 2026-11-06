// Readable view of an R script for researchers.
//
// readableSteps(source) splits a script into the steps its author marked with
// section comments ("# ---- Normalize ----" or RStudio's "# Normalize ----")
// and, for each step, returns both the exact code and a readable version with
// defensive code hidden: argument checks (stopifnot, stop, warning), guard
// clauses whose only job is to stop, and wrappers such as tryCatch, try, and
// suppressWarnings are reduced to the expression they protect.
//
// The readable version is a view for reading. The exact code is what ran.

const WRAPPERS = ['tryCatch', 'withCallingHandlers', 'try', 'suppressWarnings', 'suppressMessages',
  'suppressPackageStartupMessages'];
const GUARD_CALLS = /^(stopifnot|stop|warning|message|validate_[A-Za-z0-9_.]*|assert[A-Za-z0-9_.]*|on\.exit)$/;
const STEP_MARKER = [
  /^\s*#+\s*-{2,}\s*(.*?)\s*-{2,}\s*$/, // # ---- Title ----
  /^\s*#+\s*(?!-)(.+?)\s*(?:-{4,}|={4,}|#{4,})\s*$/, // # Title ----
];

// Replaces string literals and comments with spaces so structure can be found
// with simple scans. Offsets match the original text.
function mask(source) {
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') { out[i] = ' '; i += 1; }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out[i] = ' '; i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { if (source[i] !== '\n') out[i] = ' '; i += 1; }
        if (i < source.length && source[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < source.length) { out[i] = ' '; i += 1; }
      if (quote === '`') {
        // Backticked names are identifiers; keep a placeholder so they stay words.
        out[i - 1] = 'x';
      }
    } else {
      i += 1;
    }
  }
  return out.join('');
}

const PAIRS = { '(': ')', '[': ']', '{': '}' };

function matchClose(masked, open) {
  const stack = [PAIRS[masked[open]]];
  for (let i = open + 1; i < masked.length; i += 1) {
    const ch = masked[i];
    if (PAIRS[ch]) stack.push(PAIRS[ch]);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

// Top-level comma-separated argument ranges inside (open, close).
function argumentRanges(masked, open, close) {
  const ranges = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const ch = masked[i];
    if (PAIRS[ch]) depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { ranges.push([start, i]); start = i + 1; }
  }
  ranges.push([start, close]);
  return ranges;
}

function dedent(text) {
  const lines = text.split('\n');
  // A closing bracket of an enclosing function should not pin the indent at 0.
  const indents = lines.filter((line) => line.trim() && !/^[)}\]\s]+$/.test(line)).map((line) => /^\s*/.exec(line)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut)).join('\n');
}

function indentLines(text, indent) {
  return text.split('\n').map((line, index) => (index === 0 || !line.trim() ? line : indent + line)).join('\n');
}

// Reduces one wrapper call per pass; returns null when nothing changed.
function unwrapOnce(source) {
  const masked = mask(source);
  const pattern = new RegExp(`(^|[^A-Za-z0-9_.])(${WRAPPERS.join('|')})\\s*\\(`, 'g');
  let match;
  while ((match = pattern.exec(masked))) {
    const nameStart = match.index + match[1].length;
    const open = masked.indexOf('(', nameStart);
    const close = matchClose(masked, open);
    if (close === -1) continue;
    const args = argumentRanges(masked, open, close);
    const exprRange = args.find(([a, b]) => {
      const text = masked.slice(a, b);
      return !/^\s*[A-Za-z_.][A-Za-z0-9_.]*\s*=(?!=)/.test(text) || /^\s*expr\s*=(?!=)/.test(text);
    });
    if (!exprRange) continue;
    let expr = source.slice(exprRange[0], exprRange[1]).replace(/^\s*expr\s*=(?!=)/, '').trim();
    const lineStart = source.lastIndexOf('\n', nameStart - 1) + 1;
    const before = source.slice(lineStart, nameStart);
    const statementStart = /^\s*$/.test(before);
    const indent = /^\s*/.exec(before)[0];
    if (expr.startsWith('{') && expr.endsWith('}') && matchClose(mask(expr), 0) === expr.length - 1) {
      const body = dedent(expr.slice(1, -1).replace(/^\s*\n/, '').replace(/\n\s*$/, ''));
      const single = statements(body).filter((s) => mask(s.text).trim());
      if (single.length === 1) expr = single[0].text.trim();
      else expr = statementStart ? indentLines(body.trim() ? body : '', indent) : `{\n${indentLines(body, `${indent}  `)}\n${indent}}`;
      if (!statementStart) expr = expr.replace(/^\{\n/, `{\n${indent}  `);
    }
    return source.slice(0, nameStart) + expr + source.slice(close + 1);
  }
  return null;
}

// Statement ranges at the top nesting level of `source` (lines grouped until
// brackets balance). Returns [{ start, end, text }].
function statements(source) {
  const masked = mask(source);
  const result = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= masked.length; i += 1) {
    const ch = masked[i];
    if (ch && PAIRS[ch]) depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (i === masked.length || (ch === '\n' && depth === 0 && !/(?:[-+*/^,|&=<>~]|%[^%\s]*%|\bin|<-)\s*$/.test(masked.slice(start, i)))) {
      result.push({ start, end: i, text: source.slice(start, i) });
      start = i + 1;
    }
  }
  return result;
}

function callName(maskedStatement) {
  const m = /^\s*([A-Za-z_.][A-Za-z0-9_.]*)\s*\(/.exec(maskedStatement);
  return m ? m[1] : null;
}

// True for statements whose only effect is to check something and stop.
function isGuard(statement) {
  const masked = mask(statement).trim();
  if (!masked) return false;
  const name = callName(masked);
  if (name && GUARD_CALLS.test(name)) {
    const open = masked.indexOf('(');
    return matchClose(masked, open) === masked.length - 1;
  }
  const guard = /^if\s*\(/.exec(masked);
  if (!guard) return false;
  const open = masked.indexOf('(');
  const close = matchClose(masked, open);
  if (close === -1) return false;
  let rest = masked.slice(close + 1).trim();
  const original = statement.trim();
  let body = original.slice(original.length - rest.length);
  if (rest.startsWith('{')) {
    const end = matchClose(rest, 0);
    if (end !== rest.length - 1) return false;
    body = body.slice(1, -1);
    rest = rest.slice(1, -1);
  }
  if (/\belse\b/.test(rest)) return false;
  const inner = statements(body).map((s) => s.text).filter((s) => mask(s).trim());
  return inner.length > 0 && inner.every((s) => {
    const n = callName(mask(s).trim());
    return n && /^(stop|warning|stopifnot|return|message)$/.test(n);
  });
}

function readable(code) {
  let text = code;
  for (let pass = 0; pass < 50; pass += 1) {
    const next = unwrapOnce(text);
    if (next === null) break;
    text = next;
  }
  return stripGuards(text).replace(/\n{3,}/g, '\n\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
}

// Drops guard statements at this level and inside every braced block.
function stripGuards(text, depth = 0) {
  const kept = statements(text).filter((s) => !isGuard(s.text)).map((s) => (depth < 20 ? stripInnerBlocks(s.text, depth) : s.text));
  return kept.join('\n');
}

function stripInnerBlocks(statement, depth) {
  const masked = mask(statement);
  let out = '';
  let cursor = 0;
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] !== '{') continue;
    const close = matchClose(masked, i);
    if (close === -1) break;
    const inner = statement.slice(i + 1, close);
    const stripped = stripGuards(inner, depth + 1);
    let body = stripped;
    if (stripped !== inner && inner.includes('\n')) {
      body = `${stripped.replace(/\s+$/, '')}\n${/\n([ \t]*)$/.exec(inner)?.[1] ?? ''}`;
    }
    out += statement.slice(cursor, i + 1) + body;
    cursor = close;
    i = close;
  }
  return out + statement.slice(cursor);
}

function stepTitle(line) {
  for (const pattern of STEP_MARKER) {
    const m = pattern.exec(line);
    if (m && m[1] && /[A-Za-z0-9]/.test(m[1])) return m[1].replace(/^Step\s*\d*\s*[:.-]?\s*/i, '').trim() || m[1].trim();
  }
  return null;
}

export function readableSteps(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const steps = [];
  let current = { title: null, lines: [] };
  for (const line of lines) {
    const title = stepTitle(line);
    if (title) {
      steps.push(current);
      current = { title, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  steps.push(current);
  return steps
    .filter((step) => step.title || step.lines.some((line) => line.trim()))
    .map((step, index) => {
      const code = dedent(step.lines.join('\n').replace(/^(\s*\n)+/, '').replace(/\s+$/, ''));
      let view;
      try { view = readable(code); } catch { view = code; }
      return {
        number: index + 1,
        title: step.title || (index === 0 ? 'Setup' : `Step ${index + 1}`),
        code,
        readable: view,
        hiddenLines: Math.max(0, code.split('\n').filter((l) => l.trim()).length - view.split('\n').filter((l) => l.trim()).length),
      };
    });
}

export const READABLE_R_STYLE_HINT = 'Mark steps with "# ---- Step name ----" lines.';
