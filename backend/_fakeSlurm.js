'use strict';

// A fake Slurm for tests: sbatch/sacct/squeue/scancel/sinfo shell scripts on
// PATH. sbatch "runs" the job immediately by writing the runner's outputs
// (a checkpoint and result.json with its real SHA-256). Behavior is selected
// with FAKE_SLURM_MODE: complete (default), fail, hold (stays RUNNING), badsum.
// Underscore-prefixed so Vitest does not treat it as a test file.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = {
  sbatch: `#!/bin/bash
set -e
script="\${@: -1}"; run_dir="$(dirname "$script")"
n=$(( $(cat "$FAKE_SLURM_STATE/counter" 2>/dev/null || echo 1000) + 1 )); echo "$n" > "$FAKE_SLURM_STATE/counter"
echo "$@" >> "$FAKE_SLURM_STATE/sbatch.log"
name=$(grep -m1 -- '--job-name=' "$script" | sed 's/.*--job-name=//'); echo "$name $n" >> "$FAKE_SLURM_STATE/names"
mode="\${FAKE_SLURM_MODE:-complete}"
if [ "$mode" = fail ]; then echo "Error in Read10X_h5: boom" > "$run_dir/slurm.out"; echo FAILED > "$FAKE_SLURM_STATE/$n"
elif [ "$mode" = hold ]; then echo RUNNING > "$FAKE_SLURM_STATE/$n"
else
  printf 'checkpoint-bytes-%s' "$n" > "$run_dir/output/checkpoint.rds"
  sum=$(sha256sum "$run_dir/output/checkpoint.rds" | cut -d' ' -f1)
  [ "$mode" = badsum ] && sum=0000000000000000000000000000000000000000000000000000000000000000
  size=$(stat -c %s "$run_dir/output/checkpoint.rds")
  cat > "$run_dir/output/result.json" <<JSON
{"ok":true,"summary":{"n_cells":120,"n_features":2000,"n_clusters":3,"cluster_sizes":[40,40,40],"reductions":["pca","umap"],"normalization_method":"LogNormalize","resolution":0.8,"used_seed":7},"warnings":[],"checkpoint":{"saved":true,"checksum_sha256":"$sum","size_bytes":$size},"versions":{"seurat_version":"5.1.0","r_version":"4.4.1"}}
JSON
  echo COMPLETED > "$FAKE_SLURM_STATE/$n"
fi
echo "$n;cluster"
`,
  sacct: `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -j) id="$2"; shift;; --name) name="$2"; shift;; esac; shift; done
if [ -n "$id" ]; then cat "$FAKE_SLURM_STATE/$id" 2>/dev/null; exit 0; fi
if [ -n "$name" ]; then grep "^$name " "$FAKE_SLURM_STATE/names" 2>/dev/null | awk '{print $2}'; fi
`,
  squeue: `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -j) id="$2"; shift;; -n) name="$2"; shift;; esac; shift; done
active() { s=$(cat "$FAKE_SLURM_STATE/$1" 2>/dev/null); [ "$s" = RUNNING ] || [ "$s" = PENDING ]; }
if [ -n "$id" ]; then active "$id" && cat "$FAKE_SLURM_STATE/$id"; exit 0; fi
if [ -n "$name" ]; then for i in $(grep "^$name " "$FAKE_SLURM_STATE/names" 2>/dev/null | awk '{print $2}'); do active "$i" && echo "$i"; done; fi
exit 0
`,
  scancel: `#!/bin/bash
echo CANCELLED > "$FAKE_SLURM_STATE/$1"; echo "$1" >> "$FAKE_SLURM_STATE/scancel.log"
`,
  sinfo: `#!/bin/bash
echo "normal* up 4"; echo "gpu up 2"
`,
};

function installFakeSlurm() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-slurm-'));
  const bin = path.join(base, 'bin');
  const state = path.join(base, 'state');
  const remote = path.join(base, 'remote');
  for (const dir of [bin, state, remote]) fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(SCRIPTS)) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  const saved = {};
  const env = {
    PATH: `${bin}:${process.env.PATH}`, FAKE_SLURM_STATE: state, SLURM_TRANSPORT: 'local',
    SLURM_REMOTE_ROOT: remote, SLURM_POLL_SECONDS: '1', SLURM_PARTITION: 'normal', SLURM_ACCOUNT: 'lab01',
  };
  for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value; }
  return {
    base, state, remote,
    sbatchCalls: () => (fs.existsSync(path.join(state, 'sbatch.log')) ? fs.readFileSync(path.join(state, 'sbatch.log'), 'utf8').trim().split('\n').filter(Boolean) : []),
    scancels: () => (fs.existsSync(path.join(state, 'scancel.log')) ? fs.readFileSync(path.join(state, 'scancel.log'), 'utf8').trim().split('\n').filter(Boolean) : []),
    setState: (id, value) => fs.writeFileSync(path.join(state, String(id)), `${value}\n`),
    restore: () => {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

module.exports = { installFakeSlurm };
