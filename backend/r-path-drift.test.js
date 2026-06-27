/**
 * R path-field drift guard (audit finding 4).
 *
 * Node-side validateRProxyPaths() validates a fixed allowlist of request fields
 * (R_PROXY_VALIDATED_PATH_FIELDS) before proxying to R. The R backend validates
 * paths independently with validate_path(), but if a NEW R endpoint introduces a
 * path-like request field that Node doesn't also validate, the Node-side guard
 * silently stops covering it. This is a pragmatic STATIC test (not a full R
 * parser, per the audit): it scans every validate_path() call site in
 * r-backend/plumber.R, resolves the originating request field name, and asserts
 * that field is covered by the Node allowlist.
 *
 * Would fail if, e.g., someone adds `validate_path(req$body$matrix_path)` in R
 * without adding 'matrix_path' to R_PROXY_VALIDATED_PATH_FIELDS in server.js.
 *
 * Limitation (documented): it resolves simple argument forms — a bare local
 * (`path`), a member access (`req$body$path`), and the `vapply(<var>,
 * validate_path, ...)` form. If a future call site uses a shape this scanner
 * can't resolve, the test fails loudly and asks a human to extend it rather
 * than silently passing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const serverModule = require('../server.js');
const { R_PROXY_VALIDATED_PATH_FIELDS } = serverModule.default || serverModule;

const PLUMBER_PATH = path.join(__dirname, '..', 'r-backend', 'plumber.R');

// Reduce an argument expression to the request field name it ultimately reads.
// e.g. 'req$body$path' -> 'path', 'csv_path' -> 'csv_path', 'path' -> 'path'.
function argToField(rawArg) {
  const arg = rawArg.trim();
  // Take the final identifier after any '$' member access.
  const lastSegment = arg.split('$').pop().trim();
  const m = lastSegment.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
  return m ? m[0] : null;
}

function extractValidatedFields(source) {
  const fields = new Set();
  const unresolved = [];

  // 1. Direct calls: validate_path(<arg>, ...)
  const callRe = /\bvalidate_path\s*\(\s*([^,)]+)/g;
  let m;
  while ((m = callRe.exec(source)) !== null) {
    const field = argToField(m[1]);
    if (field) fields.add(field);
    else unresolved.push(m[1].trim());
  }

  // 2. Functional form: vapply(<var>, validate_path, ...)
  const vapplyRe = /\bvapply\s*\(\s*([A-Za-z0-9_.$]+)\s*,\s*validate_path\b/g;
  while ((m = vapplyRe.exec(source)) !== null) {
    const field = argToField(m[1]);
    if (field) fields.add(field);
    else unresolved.push(m[1].trim());
  }

  return { fields: [...fields], unresolved };
}

describe('R path-field drift guard', () => {
  const source = fs.readFileSync(PLUMBER_PATH, 'utf8');
  const { fields, unresolved } = extractValidatedFields(source);

  it('finds at least the known validate_path call sites', () => {
    // Sanity check that the scanner actually matched something — guards against
    // the regex silently breaking and the test passing vacuously.
    expect(fields.length).toBeGreaterThan(0);
    expect(fields).toContain('path');
  });

  it('resolves every validate_path argument to a request field', () => {
    expect(unresolved,
      `Unresolvable validate_path() argument(s): ${unresolved.join(', ')}. ` +
      'Extend backend/r-path-drift.test.js to resolve these, then ensure the ' +
      'field is covered by R_PROXY_VALIDATED_PATH_FIELDS in server.js.'
    ).toEqual([]);
  });

  it('covers every R validate_path field in the Node allowlist', () => {
    const allowlist = new Set(R_PROXY_VALIDATED_PATH_FIELDS);
    const uncovered = fields.filter(f => !allowlist.has(f));
    expect(uncovered,
      `R validate_path uses request field(s) not validated Node-side: ${uncovered.join(', ')}. ` +
      'Add them to R_PROXY_VALIDATED_PATH_FIELDS in server.js (and validate them ' +
      'in validateRProxyPaths) so a new R path field cannot bypass Node-side validation.'
    ).toEqual([]);
  });
});
