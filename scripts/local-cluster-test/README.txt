Local TraceOmics MCP + SSH + simulated Slurm acceptance fixture

Run from PowerShell in the repository:
  ./scripts/local-cluster-test/setup.ps1 -Paper

Prerequisites: Docker Desktop Linux containers, Node dependencies installed in
the checkout, Windows OpenSSH client, and the project's traceomics-r:single-host
R image. The fixture builds a small SSH overlay on that R image. It uses fixed
localhost ports 45432 (PostgreSQL), 43222 (SSH), and 48000 (internal R API).
Do not use these scripts against shared installations. All accounts, sessions,
delegations, workflow approvals and study acceptances are synthetic fixtures.
No user credential or existing app session is needed.

Real components exercised:
- Current Express routes, PostgreSQL schema and policy checks.
- Actual MCP server over newline-delimited JSON-RPC stdio.
- Delegated planning and submission, fixed parameter constraints, idempotency.
- Current job worker, SSH/SCP transport with pinned host-key verification.
- Current staged hpc-runner.R and seuratPipelineCore.R executing actual Seurat.
- Checkpoint transfer, SHA-256 verification, provenance and result recording.
- Checkpoint-backed marker finding through the real R API and app worker.

Only the Slurm scheduler is simulated. The small shell scheduler launches real
job.sh processes in its container. This is a serial test fixture, not a Slurm
implementation: it does not enforce SBATCH limits, model queues/fair-share,
support concurrent scheduler admissions safely, or test real HPC site policy.
Docker bounds local resources to 2 CPUs/8 GiB for the SSH cluster and 2 CPUs/
6 GiB for the R API. SSH root access exists only in the disposable container,
accepts the fixture key only, and binds to localhost.

Paper scope:
Zheng et al. (2017), DOI 10.1038/ncomms14049, Figure 3 and Supplementary Data 3.
Use the authors' public pbmc68k_data.rds, transpose its cell-by-gene sparse
matrix, and freeze 10,000 randomly selected cells using seed 20261108 before
inspecting results. HDF5 conversion is checked for equality. This is a partial
biological reproduction with modern Seurat methods. It is not a reproduction
of the original full-data k-means/t-SNE analysis. The app currently scales all
retained genes densely; the full 68k data exceeds this local test's memory budget.

Observed acceptance run:
- PBMC3k: 2,638 retained cells, 9 clusters; actual SSH checkpoint collected.
- Direct-vs-SSH checks: identical barcodes, genes, variable features and labels;
  normalized counts/PCA/UMAP agree to the documented numeric tolerances.
- Paper subset: 10,000 cells; 16 clusters at resolution 0.5.
- Transport injection scenarios: no duplicate sbatch on recovery, corrupted
  checkpoint rejection/removal, FAILED state handling, real scancel delivery.
- R checkpoint loading required a 3 GiB per-session budget; 1 GiB rejected it.

Outputs are in exports/paper-reproduction, including reports and RDS checkpoints.
setup.ps1 leaves its containers for inspection. The original acceptance session
removes its containers after exporting evidence. To remove only this fixture:
  docker rm -f -v tro-mcp-pg-test tro-mcp-cluster-test tro-mcp-r-test
Keep the report files and scripts. Scratch inputs, temporary credentials, and
generated checkpoints remain local and ignored by Git.

Helper scripts:
- verify-direct.R: an execution-path oracle using identical code/settings.
  It is not an independent implementation of Seurat.
- retry-markers.mjs: debug-only recovery against the retained disposable DB.
  It uses real MCP tool handlers in-process, reusing the already saved cluster.
- compare-paper.R: marker comparison and plots from app-produced artifacts.

Known fixture debugging corrections: inherited image entrypoint, test-key
passphrase quoting, legacy matrix orientation, sparse equality comparison,
canonical R state keys, and session memory budget. A production admission bug
was fixed: follow-on marker jobs now omit dataset_id because they consume an
accepted analysis object; the immutable plan still pins dataset provenance.
The regression check failed before this fix and actual R marker execution
passed afterward. Production analysis methods and authorization rules were
not weakened.
