"""Audit this trial against its pre-change workspace, not an earlier Git commit."""
import json, pathlib, difflib, hashlib

root = pathlib.Path(__file__).resolve().parents[2]
baseline = json.loads((root / 'scratch/condition-study/baseline-source.json').read_text(encoding='utf-8'))
paths = set(baseline)
for directory in ('backend', 'r-backend', 'shared', 'cli'):
    paths.update(str(p.relative_to(root)).replace('\\', '/') for p in (root / directory).rglob('*')
                 if p.is_file() and p.suffix in ('.js', '.mjs', '.cjs', '.R'))
rows, patch = [], []
for name in sorted(paths):
    old = baseline.get(name, '').splitlines()
    file = root / name
    new = file.read_text(encoding='utf-8-sig').splitlines() if file.exists() else []
    if old == new:
        continue
    diff = list(difflib.unified_diff(old, new, fromfile='a/' + name, tofile='b/' + name, lineterm=''))
    added = [s[1:] for s in diff if s.startswith('+') and not s.startswith('+++')]
    removed = [s[1:] for s in diff if s.startswith('-') and not s.startswith('---')]
    rows.append(dict(path=name, category='tests' if '.test.' in name else 'production',
                     added_lines=len(added), removed_lines=len(removed),
                     added_nonblank_lines=sum(bool(s.strip()) for s in added),
                     added_characters=sum(len(s) for s in added),
                     current_sha256=hashlib.sha256(file.read_bytes()).hexdigest() if file.exists() else None))
    patch.extend(diff)
out = root / 'exports/condition-study'
(out / 'new-code-review.patch').write_text('\n'.join(patch) + '\n', encoding='utf-8')
totals = {category: dict(files=sum(r['category'] == category for r in rows),
                        added_lines=sum(r['added_lines'] for r in rows if r['category'] == category),
                        removed_lines=sum(r['removed_lines'] for r in rows if r['category'] == category),
                        added_characters=sum(r['added_characters'] for r in rows if r['category'] == category))
          for category in ('production', 'tests')}
(out / 'code-review-audit.json').write_text(json.dumps(dict(
    basis='Pre-change source snapshot from this user request; previous uncommitted work excluded',
    totals=totals, files=rows,
    caveat='Lines and characters measure change volume, not review effort or scientific validity. Dense lines can contain substantial new logic. Test fixtures, evaluator, manuscript and annotation decisions require separate review.'), indent=2), encoding='utf-8')
print(json.dumps(totals))

# Auxiliary scripts were outside the source baseline. Inventory their full current
# contents separately; do not mislabel their sizes as measured additions.
auxiliary_names = [
    'audit-condition-review.py', 'collect-condition-study.mjs',
    'condition-mcp-client.mjs', 'condition-study-server.mjs',
    'evaluate-condition-study.R', 'evolved-readiness.mjs',
    'prepare-condition-study.R', 'summarize-condition-validation.mjs',
    'verify-condition-downstream.R', 'verify-condition-integration.R',
    'verify-condition-workbench.R', 'verify-hydration-memory.R',
    'verify-large-de-figure.R', 'verify-large-figure.R',
    'verify-plot-memory.R', 'verify-scaling-memory.R',
]
auxiliary = []
for name in auxiliary_names:
    file = root / 'scripts/local-cluster-test' / name
    data = file.read_bytes()
    auxiliary.append(dict(path=str(file.relative_to(root)).replace('\\', '/'),
                          bytes=len(data), lines=len(data.splitlines()),
                          sha256=hashlib.sha256(data).hexdigest()))
(out / 'auxiliary-code-inventory.json').write_text(json.dumps(dict(
    basis='Full current task-associated fixture, verification and evaluator scripts; no pre-change script snapshot, so these are not measured delta counts',
    files=auxiliary, totalBytes=sum(row['bytes'] for row in auxiliary),
    totalLines=sum(row['lines'] for row in auxiliary),
    caveat='Separate from production/test delta totals. Includes orchestration, data preparation and post-freeze evaluator code; requires review too.'), indent=2), encoding='utf-8')
