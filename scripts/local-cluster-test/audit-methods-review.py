"""Review inventory for the narrowed methods-only benchmark."""
import difflib
import hashlib
import json
import pathlib

root = pathlib.Path(__file__).resolve().parents[2]
baseline = json.loads((root / 'scratch/methods-benchmark/baseline-source.json').read_text(encoding='utf-8'))
names = set(baseline)
for directory in ('backend', 'r-backend', 'shared', 'cli'):
    names.update(p.relative_to(root).as_posix() for p in (root / directory).rglob('*')
                 if p.is_file() and p.suffix in ('.js', '.mjs', '.cjs', '.R'))
changes, patch = [], []
for name in sorted(names):
    file = root / name
    old = baseline.get(name, '').splitlines()
    new = file.read_text(encoding='utf-8-sig').splitlines() if file.exists() else []
    if old == new:
        continue
    diff = list(difflib.unified_diff(old, new, fromfile='a/' + name, tofile='b/' + name, lineterm=''))
    added = [s[1:] for s in diff if s.startswith('+') and not s.startswith('+++')]
    removed = [s[1:] for s in diff if s.startswith('-') and not s.startswith('---')]
    changes.append(dict(path=name, category='tests' if '.test.' in name else 'production',
                        added_lines=len(added), removed_lines=len(removed),
                        added_characters=sum(map(len, added))))
    patch.extend(diff)
scripts = ['prepare-methods-benchmark.R', 'methods-study-server.mjs', 'methods-mcp-client.mjs',
           'collect-methods-benchmark.mjs', 'evaluate-methods-benchmark.R',
           'verify-methods-evaluator.R', 'audit-methods-coverage.R', 'audit-methods-review.py']
auxiliary = []
for name in scripts:
    p = root / 'scripts/local-cluster-test' / name
    data = p.read_bytes()
    auxiliary.append(dict(path=p.relative_to(root).as_posix(), bytes=len(data),
                          lines=len(data.splitlines()), sha256=hashlib.sha256(data).hexdigest()))
out = root / 'exports/methods-benchmark'
report = dict(basis='Source snapshot at the user-authorized pivot to normal-PBMC methods benchmarking',
              sourceChanges=changes, sourceChangedFiles=len(changes),
              addedSourceCharacters=sum(c['added_characters'] for c in changes),
              auxiliaryScripts=auxiliary, auxiliaryCurrentBytes=sum(c['bytes'] for c in auxiliary),
              caveats=['Auxiliary sizes are full current files, not measured deltas; several reuse prior fixture/transport code.',
                       'Zero new source changes in this trial does not erase earlier platform additions needing human review.',
                       'The analyst executable-code count is separately recorded by the frozen author; configuration and interpretation still need review.'])
(out / 'code-review-audit.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
(out / 'new-source-review.patch').write_text('\n'.join(patch), encoding='utf-8')
print(json.dumps({k: report[k] for k in ['sourceChangedFiles', 'addedSourceCharacters', 'auxiliaryCurrentBytes']}))
