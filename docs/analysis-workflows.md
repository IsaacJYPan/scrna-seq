# Analysis workflows

## Recover an accepted analysis submission

Analysis jobs and recipe steps retain a small submission identifier on this
computer before work is submitted. The server commits a receipt with the accepted
run. Reusing that identifier returns the original run; different inputs or settings
under the same identifier are rejected. A new intentional run receives a new
identifier.

After reconnecting or reopening the app, saved identifiers are checked against the
authenticated installation, account and project using read-only requests. Open
**Project → Runs & Results → Saved submissions** to choose **Check receipt** or
**Open exact run**. The monitor opens that specific run, including an older run
when more recent work exists. Recovery never repeats a scientific submission.
Closing the desktop client does not cancel accepted server work.

If a response was lost, the app blocks further submissions in that project until
the earlier request is checked. An unavailable or missing receipt does not prove
that no work is running. Inspect existing runs before choosing **Forget unconfirmed
request**; forgetting permits a new submission and can therefore duplicate work.
The app does not resubmit the forgotten request automatically.

At most 24 saved identifiers and one monitoring selection are retained locally.
They contain IDs, hashes and timestamps, without scientific source, settings,
results, credentials or server paths. Switching accounts or installations prevents
old identifiers from being used in the new scope. Logout clears them. Recovery
requires writable browser storage, the Web Locks API in a secure browser context
and a server with submission-receipt support. Open windows coordinate their
saved identifiers before admitting work, so an unresolved submission in another
window also blocks a new submission in that project.
Earlier runs without receipts remain available in execution history. Private R
session journal and editor recovery after a full app restart remain separate work;
saved artifacts and ended-session memory are not interchangeable.

## Monitor work on the selected server

Open **Project → Runs & Results → Run monitoring** and select one of your analysis
jobs or private R commands. Runs & Results remains available while a custom recipe
is selected. The panel shows the retained server state, execution target,
queue and run elapsed time, available run notes, and resource observations.
Active selected records refresh every five seconds. **Refresh monitoring** checks
the list and the same selected record; these requests never start another run.

Progress and remaining time are explicitly unknown when the runtime does not
report them. Where the isolated R runtime can sample the selected container, CPU
and memory usage include their observation time and scope. Container CPU usage
can exceed 100% across multiple CPUs. Configured resource limits describe an
allowance, separately from measured usage. Guided R usage or unavailable samples
are labeled unreported; the app does not substitute whole-server measurements.
The worker lease, last heartbeat, and lease expiry describe the worker's last
confirmed liveness; they do not measure scientific progress.
Run notes are private to the run owner, bounded, and scrubbed of transport secrets
and private paths.

The connection status is separate from computation status. If the SSH tunnel or
service cannot be checked, the last confirmed run state and elapsed time remain
visible, with their observation time. Reconnect to the same server to inspect the
same durable run. Monitoring does not cancel, retry, or replay work. A terminal
record stops automatic polling, and changing accounts, projects, or servers
clears the previous private observations. Active observations older than ten
seconds are labeled last confirmed, including when a background tab returns to
the foreground. Stored container samples are distinguished from current usage.

## Inspect exact artifact versions

Open **Runs & Results → Artifact versions** to inspect saved analyses, private
input files, workflow outputs, or newly imported files. Select a version to see
its format, size, owner, source run, checksum, and available previews. **Copy
artifact reference** records its exact identity, project, version, and checksum.
Viewing a preview verifies the saved bytes and does not create an analysis run.

Private project owners, administrators, and analysts can import CSV/TSV sample
sheets, tables, JSON, text, PNG/JPEG images, and opaque files. Choose **New version
of selected artifact** to replace a managed file while retaining earlier
contents. Imports remain private to their owner; project membership alone does
not expose another researcher's private files. Public demos disable imports.

Table previews contain at most 100 rows and 100 columns per page, with a 256 KiB
response budget. Raster previews require at most 5 MiB and 12 million pixels.
Other supported files expose metadata only. Imports accept up to 25 MiB for
ordinary files and 200 MiB for RDS, with a per-owner project budget of 200 managed
versions and a configurable 5 GiB default. Existing large checkpoints remain in their current storage.
RDS inspection never deserializes an object in the shared guided-analysis service.

## Import data already on the selected server

In **Runs & Results**, open **Inspect or import artifact files**, then choose
**Browse server data**. Select an **Authorized data root**, browse its folders,
and select one file. Only folders granted to your account and project appear.
The same workflow works with a local analysis server or a server reached through
SSH; it uses the server currently open in the app.

Give the artifact a useful name and choose **Sample sheet (CSV/TSV)** when
appropriate. **Sample details (optional)** retains a sample ID, condition, tissue,
species, or replicate description beside the saved version. These annotations
describe the input; they do not change its contents or create a Study Design.
Choose **Import selected server file** to create an immutable private snapshot.
The server copies and verifies the complete file without downloading it to your
laptop or uploading it through the browser. Progress reports copied bytes and
the import deadline. The saved version retains its checksum, source server,
authorized folder label, relative filename, and sample description. Changes to
the original file do not change an existing snapshot.

Server imports support RDS objects, CSV/TSV tables, JSON, TXT, PNG, and JPEG files.
Archives and raw dataset directories require their separate import workflow. The default server
import ceiling is 512 MiB per file, with a shared 5 GiB managed artifact quota and
200 versions per researcher/project. Outstanding imports and R saves reserve
quota. Operators can adjust these limits; the picker shows the current policy.
Empty, changed, linked, hidden, or unauthorized source files are rejected. Large
directories require smaller subfolders when they exceed the bounded listing.

For free R, refresh **Private R console → Refresh status**, select the exact saved
input version, and start a new session. Use `read_input("VERSION_ID")` to reopen
RDS, CSV, TSV, JSON, or text inputs; use `input_path("VERSION_ID")` with an
appropriate R package for other selected files. Full RDS contents are read inside the isolated private
runtime; the laptop receives metadata and bounded previews. Importing an RDS file
does not load it into the shared guided-analysis service.

If the connection disappears, new imports are blocked. After reconnecting to the
same server, choose **Check server import status** to inspect the retained request.
An accepted snapshot can finish while the client is disconnected. The app never
automatically submits that import again. If the server process stops or the
deadline expires, inspect the failed request, refresh the source folder, and start
a new import explicitly. Public demos disable this feature; a private deployment
with no authorized data roots shows an empty picker until an operator grants one.

## Ranked Pathway Enrichment

The Pathway Enrichment tab now launches `enrichment.gsea.v1` for one selected
cluster or identity group versus the remaining cells. It ranks every gene that
can be tested by the fixed Wilcoxon comparison, maps gene symbols through an
explicit human or mouse annotation database, and runs local Gene Ontology
Biological Process GSEA. The user cannot supply R code, package names, endpoints,
or file paths.

The job is project-scoped, queued, owner-verified before R contact, protected by
the same lease and signed completion-receipt recovery used by other durable R
jobs, and publishes exactly two artifacts: a private internal CSV table and a
small metadata-only preview for the UI. Its complete CSV is available only through
the authenticated, audited result-download route. The
signed result records the R, Seurat, pathway-analysis, annotation, and organism-
database versions used, so later software changes do not erase its provenance.
UI describes the result as an association, not proof that a pathway is active;
condition-level claims still require biological-sample metadata and a
sample-aware comparison. Species is required rather than guessed. Large
comparisons use a visible, repeatable per-group cell limit (10,000 by default)
so one request cannot silently expand to every cell in a very large object.

The production R image makes `clusterProfiler`, `fgsea`, `AnnotationDbi`, edgeR,
limma, both human and mouse organism databases, and `GO.db` mandatory. The R 4.5.3 image
and real-R enrichment smoke pass on this worktree. Disposable deployment checks
cover the real database, workers, browser, and native shell; any announced public
demo must additionally pass the browser workflow through its final HTTPS host.

Custom R requires the isolated private runtime and remains disabled in the
public demo. New private-runtime setup uses project-role access for owners,
administrators, and analysts. Existing approved-account installations can retain
their operator-granted `expert_r.execute` policy. Explicit operator revocation
overrides either policy. `expert.r.v1` runs a submitted script against one
caller-owned checkpoint in a fresh digest-pinned container with
no network, no project-storage mount, a read-only root, non-root identity, dropped
capabilities, and CPU/memory/PID/time bounds. The output mount is a 200 MiB tmpfs,
so a script cannot consume the shared host disk before post-run validation. The
broker also reserves expected work/archive capacity in process and rejects a run
unless both work and durable-storage filesystems retain an operator-configured
free-space reserve. Up to 50 bounded output files (200 MiB total) are retained as
one private archive; a derived `.rds` may be retained only in this untrusted
Expert R artifact tier, and an
exact byte-for-byte copy of the input is rejected even if it uses another allowed
extension. Those controls provide workload containment and tenant isolation, not
data-loss prevention against an authorized data owner: R can transform or encode
input-derived data. Results and output bundles stay creator-private until an
explicit audited branch publish. Terminal job transport records remove source;
new submissions retain an immutable, creator-private source version in execution
history, including failed and canceled runs. Older jobs whose source was already
removed remain explicitly hash-only. Approved users can
privately import up to five selected CSV, TSV, text, JSON, or RDS files through the
server-controlled picker; those files are owner/project scoped, mounted read-only,
and addressed in R only by server-generated IDs. Owner-visible script failures use
a short fixed, path-free explanation. Sandbox RDS inputs and outputs can be reused
only by downloading/re-importing them through another isolated Expert R run; they
are never promoted into the trusted guided-analysis runtime because RDS
deserialization is an executable-code boundary. Runtime package install is
unavailable; operators manage access with
`npm run expert-r-access -- <grant|revoke|status> <email>`.

**Advanced analysis → Private R console** accepts free R cells or selected
source with an optional saved analysis and up to five exact private input
versions. Variables persist between commands in that private session. Use
`display_table()` for bounded table previews and ordinary R plotting for PNG
figures; `input_manifest`, `read_input()`, and `input_path()` address the selected
files. A selected saved Seurat analysis is available as `obj`. An empty session
supports general R inspection without requiring a preconfigured pipeline.

Reloading reconnects to an existing session without executing earlier cells.
Stopping, expiry, or process loss discards unsaved memory. The console retains
ordered source and bounded output privately, and shows uncertain completion
without retrying a command. Previews are inspection evidence until explicitly
saved; retaining them does not make an unsaved workspace fully reproducible.

Use **Save a private artifact version** to retain an existing global R binding as
an RDS object or a data frame as a complete CSV. Enter its exact binding name,
such as `obj` or `markers`, rather than an R expression. Object and table saves
add an ordered serialization command to the private source journal. The initial
per-file limit is 512 MiB with the current streamed-publication runtime; older
images retain their 20 MiB ceiling. CSV output includes every row even when the console or
browser preview shows fewer. CSV saves data columns without R row names or other
attributes; add important row identifiers as a column, or save the data frame as
an RDS object to preserve its R attributes. Tables that exceed browser column or cell budgets
remain available for inspection in private R with a metadata-only browser preview.

Use **Save figure** below a completed console PNG to retain those exact image
bytes. A retained completed figure can be saved after stopping its session. To
keep revisions together, select **Version to extend**; earlier versions keep
their own bytes, checksums, and lineage. Saves remain creator-private and survive
session termination. Their evidence records the exact source command, earlier
source references, selected inputs, runtime generation, and pinned environment.
It also reports that untracked intermediate state and external influences can
prevent exact replay.

Inspect saved outputs in the console or **Runs & Results → Artifact versions**.
To reopen an object or table, select its exact saved input version before
starting a new session, then use `read_input("VERSION_ID")`. RDS deserialization
occurs only inside the isolated private runtime. A lost save response requires
an explicit status refresh; refreshing inspects the existing receipt and never
reruns serialization. The existing one-shot R form remains available for durable
table, figure, and file-producing runs.

**Runs & Results → Execution history** brings guided jobs, recipe steps, private
R submissions, live guided R operations, and imported provenance into one bounded
view. It shows recorded source, resolved parameters, input/output versions,
timestamps, status, and environment evidence. Source, parameters, inputs, and
environment manifests remain creator-private even when a result is shared.
Tables and figures use the verified artifact inspector; arbitrary RDS files remain
metadata-only. Missing input versions, legacy source, and incomplete environment
records are listed as replay gaps rather than treated as reproducible runs.

Live guided operations obtain their execution generation and order from the
authenticated R service. The server stores that evidence before acknowledging
history persistence. Loading a checkpoint does not reset process order; restarting
the R service creates a new generation. These records describe the interactive
service process, not a persistent private R kernel. A history-write failure keeps
the completed scientific result and displays an explicit warning.

Private R and executable recipe runs now pin a checksum-addressed environment
manifest containing the exact R/Bioconductor versions, installed R package versions
and available source metadata, OS packages, architecture, and immutable runtime
image. Successful runs retain the manifest as a private artifact; recipe snapshots
retain the same environment reference. A changed worker environment refuses the
run before execution. The snapshot covers container userspace, not the host kernel,
hardware, or downloadable source archives. Restore the original image and verify
its inventory with `npm run expert-r:restore-environment -- --manifest environment.json`;
see the deployment guide for exact-image transfer and registry options.

The spatial workflow currently supports one classic 10x Visium Space Ranger ZIP
containing `filtered_feature_bc_matrix.h5` plus its `spatial/` directory. The
server inspects a bounded archive inventory first and enables the run only after
the matrix, positions, scalefactors, and low-resolution image pass validation.
The allowlisted `spatial.seurat.v1` worker independently validates and extracts
only those required entries, loads counts/image/coordinates with Seurat, performs bounded QC,
normalization, PCA, clustering, and UMAP, and saves a reusable checkpoint with
lineage and provenance. Visium HD, Xenium, arbitrary spatial layouts, and
multi-sample spatial integration are not yet supported.

The approved multi-condition preparation workflow accepts 2-48 separately
uploaded, validated 10x HDF5 datasets from one project. Each dataset is bound to
one unique sample name and an explicit condition, with optional donor and batch
labels. The allowlisted `seurat.multisample.v1` worker resolves every dataset from
the claimed project job, merges the count matrices with unique cell identifiers,
adds `sample_id`, `condition`, `donor_code`, and `batch` metadata, runs the bounded
Seurat preprocessing recipe, and saves one reusable checkpoint-backed result. It
does not perform automatic batch correction or make a biological condition claim.
The UI reports when fewer than two samples are present in a condition because the
downstream pseudobulk gate will reject that comparison.

Study Design may register more than two conditions, but each saved
`condition.pseudobulk_de.v1` run is one explicit numerator-versus-denominator
contrast. It requires at least two independent samples or donors in each selected
condition, supports donor-paired designs only when donor identities match, and
runs edgeR quasi-likelihood pseudobulk separately per cell type. Unpaired runs
use exactly `~ condition`; paired runs use exactly `~ donor + condition`.
Blocking-factor or covariate requests fail before queueing and again at the worker
boundary, so no accepted design term is silently discarded. Multi-arm omnibus
models, general covariate formulas, and automatic batch correction/integration of
multiple raw condition datasets are not implemented. The approved multi-condition
workflow can now ingest and merge separate raw 10x HDF5 samples into one saved
analysis with explicit sample/condition metadata. The existing Batch Integration tab can
apply Harmony or Seurat CCA to 2-100 technical-batch labels already present in one
loaded Seurat object; it is not a multi-file importer or a substitute for a
biological condition contrast.

The public website demo uses `deploy/compose.demo.yml` as an overlay on a wholly
separate Compose project. It provisions temporary guest projects from one
operator-reviewed canonical checkpoint plus a remapped sample/condition/contrast
design, disables uploads and Expert R, permits one active heavy job per guest and
two globally, and requires the scheduled `demo:cleanup` operation to remove
expired guest projects and files. `deploy/compose.demo-free-tier.yml` adds a
resource-capped ARM64/Caddy candidate for a small public synthetic-data demo; see
the deployment guide before using it. The disposable demo acceptance creates the
real synthetic checkpoint and drives Chromium through UMAP and exploratory
analysis; the ARM64 public host remains a separate required acceptance target. Demo
credentials, Postgres, storage volumes, R tokens, and session secrets must never
be shared with a private deployment.
