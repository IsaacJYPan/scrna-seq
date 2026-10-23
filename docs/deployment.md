# Deploying TraceOmics

## Start here

This document contains two different levels of detail:

1. **The checklist below** is for someone who wants a small public demonstration
   website. It explains the few decisions and account-level actions that cannot
   be automated safely.
2. **The operator reference** contains the exact security, backup, recovery, and
   Docker commands used by a deployment engineer. You do not need to understand
   that entire section to request or operate the first demo with assistance.

### The public demo in plain language

The public demo runs only the bundled synthetic 800-cell tutorial. Visitors get
temporary isolated guest projects. They cannot upload datasets or use Expert R,
and expired guest work is deleted automatically. This demo must be kept separate
from any private research deployment.

You need to provide one small internet server. The recommended no-monthly-cost
candidate is an Oracle Cloud Always Free Ampere VM, subject to Oracle's current
availability and idle-instance policy. Create it with:

- Ubuntu on ARM64;
- 2 OCPUs and 12 GB RAM;
- a public IPv4 address;
- at least 50 GB of boot storage;
- your SSH public key;
- inbound ports 80 and 443 open to the internet;
- inbound port 22 restricted to your own IP address when practical.

Then configure a short SSH name on your computer. For example, the following in
`~/.ssh/config` lets a deployment engineer connect using `ssh traceomics-demo`:

```sshconfig
Host traceomics-demo
  HostName YOUR_VM_PUBLIC_IP
  User ubuntu
  IdentityFile ~/.ssh/YOUR_PRIVATE_KEY
```

Do not paste the private key, cloud password, or generated application secrets
into chat. When asking for deployment help, provide only:

- the SSH name, such as `traceomics-demo`;
- your domain name, if you have one.

A domain is optional for the first demo. A temporary hostname derived from the
public IP can be used with `sslip.io`. Once SSH works, the remaining work can be
performed by the deployment engineer: install Docker, copy TraceOmics, generate
secrets on the VM, build the ARM64 images, create the synthetic template, start
HTTPS, install automatic guest cleanup, and run browser acceptance.

### How you know the demo is finished

The deployment is complete only when all of these are true:

- the public address uses HTTPS without a certificate warning;
- a visitor can start a guest session without creating an account;
- the synthetic UMAP and Exploratory Analysis pages render successfully;
- uploads and Expert R are unavailable;
- Postgres and all R ports remain private;
- expired guest cleanup is scheduled;
- the final browser acceptance report passes against the public HTTPS address.

### Public demo versus private research deployment

| | Public demonstration | Private research deployment |
|---|---|---|
| Data | Bundled synthetic tutorial only | Lab-controlled research data |
| Users | Temporary guests | Operator-created accounts |
| Uploads | Disabled | Role-controlled and size-bounded |
| Expert R | Disabled | Optional isolated sandbox |
| Availability | Best effort | Operated according to lab requirements |
| Suitable for sensitive data | No | Only after institutional security review |

The rest of this document is the technical operator reference. Keep it because
the short checklist is not a substitute for security, backup, recovery, and
acceptance procedures.

## Operator reference

### Supported single-host deployment

This document describes the bounded deployment shape implemented in this
worktree. It is a conservative deployment candidate for a Linux host with Docker
Compose. Disposable Compose acceptance covers concurrent isolated real-R lanes,
deployment enrichment/exploration/pseudobulk, the Expert R sandbox, and the
separate public-demo lifecycle. The private deployment harness also logs in four
independent users and proves private/published branch behavior, concurrent head
conflicts, stale-review rejection, canonical promotion, controlled result
streaming, reproducibility manifests, and append-only audit enforcement. A
Windows acceptance harness also drives a real
browser plus two native Electron profiles through checkpoint-backed UMAP,
exploration, and overlapping private DEG jobs, recording only the exact native
window handles. That native harness first uploads a real PBMC3K 10x HDF5 input,
requires the durable Seurat pipeline to complete inside its finite ten-minute R
bridge deadline without receipt recovery, and continues through checkpoint load.
The disposable public-demo stack also passes a real Chromium
guest flow through checkpoint hydration, UMAP, and exploratory analysis. The
public demo still requires an on-host ARM64 build and the same browser acceptance
against its public HTTPS origin before its URL can be announced. This is not a claim of
high availability, elastic R scaling, or hard multi-tenant compute isolation.

The supported exposure model is a trusted lab/team whose accounts are
provisioned by the host operator. It is not an anonymous-signup service or a
hostile-user multi-tenant SaaS boundary.

For private use, this is a self-hosted/BYOC-style topology: the customer or lab
operates every application and data-plane component on infrastructure it
controls. It does not depend on a vendor-managed control plane. “BYOC” here does
not imply high availability, managed operations, compliance certification, or
safe execution of arbitrary hostile workloads. Those properties require
separate architecture and operational evidence.

## Private R execution

Expert R is disabled by default and must remain disabled for the public demo. For
a private deployment, set `APP_DEPLOYMENT_MODE` to an exact approved private mode,
create the absolute host work root, build and digest-pin the R image, set the
`EXPERT_R_*` variables in the environment file, then start with the `expert-r`
Compose profile. Unknown modes fail closed. The broker shares the private service
namespace and listens only on loopback; it publishes no port and must never be
routed through the public reverse proxy. A wildcard or non-loopback broker URL is
rejected. Treat access to its Docker socket as a privileged operator boundary.
Production refuses `/var/run/docker.sock`. Provision a dedicated rootless Docker
daemon (the example uses UID/GID 10001), set `EXPERT_R_RUNTIME_SOCKET` to that
daemon's Unix socket, and make `EXPERT_R_SANDBOX_HOST_WORK_ROOT` an absolute
directory owned by the same account. That daemon must be reserved for Expert R
workloads; do not schedule application, database, proxy, or unrelated containers
on it. The broker itself remains non-root and receives only that socket.

For a new private installation, prepare the dedicated rootless daemon and its
mode-0700 work root under the installation's non-root `APP_UID`/`APP_GID`, and
load the reviewed, digest-pinned R image into that daemon. Run the setup
preflight on its Linux host:

```bash
node scripts/configure-private-r.js \
  --deployment-env /private/installation.env \
  --image traceomics-r@sha256:YOUR_REVIEWED_IMAGE_DIGEST \
  --socket /run/user/10001/docker.sock \
  --work-root /srv/traceomics-expert \
  --output /private/private-r.env
docker compose --env-file /private/installation.env \
  --env-file /private/private-r.env -f deploy/compose.single-host.yml \
  --profile expert-r up -d
```

The preflight verifies rootless isolation, daemon dedication, filesystem
ownership, immutable image availability, R/Bioconductor versions, the installed
package profile, isolated runner, and the exact sandbox user and read-only
input/writable output mounts. It refuses to overwrite an existing
configuration. Use the application's Docker runtime to start Compose; the
dedicated daemon remains reserved for analysis containers. The generated file
contains a credential and must remain private.

New setup also selects `PRIVATE_R_KERNEL_ENABLED=true`. With the current pinned
R image, the broker independently verifies IRkernel and the reference Jupyter
client before advertising persistent sessions. Named object/table export and
cooperative interruption support are probed independently. Images with older
kernel adapters can still run console commands while their unsupported controls
remain unavailable. Older images can continue
one-shot R; the console reports missing kernel support separately. Existing
installations can enable the flag in their private environment file and rebuild
and pin the current R image. No kernel connection file or port is published.

Persistent sessions run as one private non-root, networkless container per
researcher and workspace. The application allows one active session per account
and two globally. Defaults are 8 GiB memory, two CPUs, a 15-minute idle timeout,
a four-hour total lifetime, and a five-minute command limit. Operators can tune
`PRIVATE_R_KERNEL_MEMORY_LIMIT`, `PRIVATE_R_KERNEL_CPU_LIMIT`,
`PRIVATE_R_KERNEL_IDLE_SECONDS`, `PRIVATE_R_KERNEL_LIFETIME_SECONDS`, and
`PRIVATE_R_KERNEL_EXECUTION_SECONDS` within the runtime's bounded policy. Stopping,
expiry, process loss, or broker restart discards unsaved variables and files.
The private database retains exact selected input references, environment
manifest, source, command order, and bounded console previews. A lost response
leaves completion unconfirmed until inspected; it never triggers automatic
execution.

The console can explicitly save a global R binding as RDS, a data frame as full
CSV, or a completed preview PNG as an immutable, creator-private managed artifact
version. With a pinned image containing the streamed-publication bridge,
object/table exports flow through a bounded pipe to private broker disk and then
durable storage. The default output ceiling is 512 MiB per save; admission can
lower it to the remaining managed quota. RDS uses version-3 serialization without
compression; full CSV tables use the same bounded stream. The browser receives
metadata and bounded previews rather than the complete object. Serialization
shares command ordering and exclusivity with ordinary R execution. The server
reserves storage capacity before export, verifies actual saved bytes, and commits
the version and source/input/environment lineage together. Pending or unconfirmed
saves retain quota reservations. Completed versions survive stopping or restoring
the session; unsaved R memory does not. Backups include publication receipts and
managed output files, and restore marks unfinished saves unconfirmed without
rerunning them.

The default selected-input limits are 512 MiB per version and 1 GiB total, with
a 5 GiB managed artifact quota per researcher/project and 200 retained versions.
These are configurable ceilings, not a measured guarantee that every dataset
fits in R's memory. A streamed 224 MiB RDS save and exact-version reopening are
covered by `test:large-r-artifacts-browser`; realistic biological dataset sizing
still requires measurements on the provisioned server.

Apply the following policy to both the web service and sandbox broker. The
supported Compose deployment forwards the same values to both automatically.
Admission uses the lower verified service/broker input and output ceilings;
disk reserve and transfer time report the actual broker controls.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRIVATE_R_MAX_OUTPUT_BYTES` | `536870912` | Maximum named RDS/CSV save, further bounded by remaining quota. |
| `PRIVATE_R_MAX_INPUT_FILE_BYTES` | `536870912` | Maximum selected saved version for a private session. |
| `PRIVATE_R_MAX_INPUT_TOTAL_BYTES` | `1073741824` | Total selected input bytes staged for one session. |
| `PRIVATE_R_MANAGED_QUOTA_BYTES` | `5368709120` | Saved versions plus outstanding reservations for one researcher/project. |
| `PRIVATE_R_DISK_RESERVE_BYTES` | `1073741824` | Free-space floor after shared runtime reservations. |
| `PRIVATE_R_TRANSFER_TIMEOUT_SECONDS` | `900` | Bounded private publication stream lifetime. |

Byte values must be positive integers no greater than 64 GiB; total input must
cover the per-file input ceiling. Transfer time must be 1–3600 seconds. Malformed
production configuration fails startup. Existing runtime memory, CPU, command,
idle, and lifetime controls continue to apply. Named saves reserve staging and
durable-copy capacity, including concurrent one-shot work on shared filesystems.
Arbitrary unsaved scratch files remain in a hard-bounded 200 MiB tmpfs; this
feature does not provide a general writable host-directory mount. Standalone
private-input and artifact uploads retain their separate 200 MiB ceiling.

The maximum save bytes and effective policy are retained with each admission.
Lowering a quota blocks new reservations while preserving earlier versions and
already admitted saves. Interrupted, oversized, or unverified streams cannot
publish partial versions. A lost response is inspected through its existing
receipt, without repeating serialization. Older pinned images retain their
original 20 MiB output and 200/250 MiB input limits until updated.

This release requires database schema contract `20261032`. Apply
`npm run init:postgres` with the migration owner's database credentials before
starting the upgraded services. The idempotent migration expands publication
bounds and requires every completed size to fit its retained reservation;
it also adds durable analysis submission receipts and preserves the original
workflow submission identifiers. It adds project research analyses and append-only
draft revisions, keeping scientific artifacts separate from editable notes.
Completed outside-result attachments have independent append-only caption/origin
revisions and exact managed-file references. Supplied origin notes are unverified;
project membership never grants access to another owner's private source bytes.
Attachment corrections retain an exact predecessor and independent source owner;
earlier referenced managed files cannot be removed by normal cleanup. Historical
captions and original request receipts remain readable under current membership.
Current project readers can discuss exact attachment revisions in active analyses
without receiving edit or private-file access. Discussion retains immutable text,
contributor labels, timestamps and submission receipts; audits omit comment text.
Local evidence intake adds bounded owner-private metadata recipes before upload.
The persisted installation identity, exact file checksum/settings, intended
analysis action and separate attachment request UUID survive reconnection and
app restart. Current project readers can recover their own original admissions
and accepted outcomes; fresh upload/attachment requires current write access to
an active non-demo analysis. Recovery never transfers or attaches automatically,
and recipes contain no file bytes or local file paths. Import acceptance remains
recorded when a source is unavailable; a missing receipt is unconfirmed. Retain
these immutable recipes and existing import/attachment receipts together during
backup and restore. Scoped demo cleanup removes recipes before analysis rows.
Granted server-file imports retain their normalized request and exact final
acceptance in the existing durable import journal. Owner-private bounded history
and exact recovery require current project membership; fresh imports separately
require current write/deployment permission and the current source-root grant.
Earlier accepted imports remain recorded after a managed source row or file is
unavailable, without reopening a source or restarting transfer. The migration
backfills older completed acceptance only from matching retained managed metadata;
missing older evidence is explicitly legacy-unrecorded. Keep the import journal
with its managed storage during backup; normal cleanup cannot delete its receipts.
Fresh server imports are bounded to 2000 retained requests per project and owner;
exact replay precedes that bound. Discovery pages contain at most 30 metadata
records and perform no file hashing or source-file checks. Request metadata is
limited to 8 KiB in compact and PostgreSQL JSONB form; terminal acceptance is 2 KiB.
Analysis evidence admissions now share `research_analysis_intakes`, with an
immutable local or server source kind. The migration renames the earlier local
journal before creating or extending it; it preserves existing recipes, hashes,
UUIDs and timestamps. Back up this one journal with both import journals and
attachment history. Existing local-intake API aliases remain source-filtered.
The two source kinds share the 2000-admission bound per analysis and the original
import/attachment UUID uniqueness rules. Server evidence intake supports new
automatic CSV, TSV, PNG and JPEG snapshots up to the smaller of the configured
server limit and 200 MiB. Admission records a signed selection and size, not an
invented pre-copy checksum; only the existing completed copy supplies acceptance.
Source preflight occurs before analysis locks, and transfer uses the existing
server importer. Recovery does not reopen original source paths, start copies
or attach results automatically. Loss of a source grant can disable copying
while an already accepted owned snapshot remains eligible for attachment under
the analysis's current write permission. Expired copy operations are reconciled
outside analysis transactions with the existing proof-based cleanup.

Private snapshot preparations retain exact selected CSV/TSV/PNG/JPEG attachment
views and optional saved script/notebook versions. They do not publish results,
change branch visibility, grant other members file access, or run a scientific
runtime. Original source reads use the existing verified storage provider; the
small retained views and source copies are bounded PostgreSQL bytea records.
Back up these database records with their immutable package metadata. Each
preparation is limited to eight result views, two saved source versions (1 MiB
each), 200 MiB of distinct original result sources, and 16 MiB of retained bytes
including metadata. Capacity is bounded to ten live preparations and 128 MiB per
owner/project, plus 512 MiB per project; include this database and backup growth
in deployment sizing. Failed or interrupted preparations retain their reservation
until explicit resume or deletion. At most 2000 original request identities per
owner/project, including source-free deleted tombstones, are retained.
Ready blobs, metadata and exact checksums commit atomically. Owner-private
deletion invalidates pending builders, removes unshared retained blobs and releases private quota
in one transaction. Current project readers can recover and remove their own
preparations, including from archived analyses; fresh preparation/resume requires
current write access to an active non-demo analysis. Reading a record never builds,
repairs, publishes or executes it. Missing retained bytes preserve the original
recorded package/hash and are reported unavailable. Raster copies retain their
original complete file bytes, including embedded metadata; no EXIF removal or
restriction against saving displayed data is claimed.

Explicit snapshot publication makes one acknowledged ready package's fixed
findings and selected saved supporting source readable to current project
members. It does not change branch visibility or ordinary original-file,
SSH, execution or edit permissions. At most one publication per private
preparation can be active. Publication copies bounded immutable manifest metadata
and references the same retained BYTEA rows; it does not duplicate scientific
payloads. Removing the private preparation keeps bytes needed by an active
publication. Withdrawal blocks subsequent shared reads, retains acceptance/audit
history and removes payloads only when no ready private preparation or active
publication needs them. Already delivered data cannot be revoked.
The existing 512 MiB project limit covers private reservations, distinct retained
payloads and publication metadata together. Each publication charges its bounded
manifest plus 8 KiB reserved operation/audit allowance, including its first
withdrawal receipt. At most 2000 publication acceptances per project, including
withdrawn history, are retained; the corresponding action journal has at most
4000 accepted records. Capacity exhaustion blocks new publication, never
withdrawal. These logical budgets exclude PostgreSQL indexes, WAL, TOAST and
backup overhead. Preserve database records together in backups; never remove
BYTEA rows or references manually to free space. Private accepted action
discovery supports recovery after a lost response/browser restart without
putting scientific request data in browser storage. Unaccepted in-memory actions
cannot be discovered after restart. Readers must still be current project
members; publisher downgrade or archive does not prevent withdrawal by the
publisher, and current project owner/admin can withdraw on the project's behalf.
Existing versions, source receipts, restart
links and jobs remain intact. Earlier workflow runs without recorded request
contents remain visible in history; the service cannot verify that a repeated
request matches those earlier inputs and reports a conflict instead of
submitting additional work.

Interrupt targets the exact active command and session generation. The broker
confirms both R's matching terminal reply and its idle state before permitting
another command. Interrupted commands retain their exact source and a distinct
history outcome; partial tables and figures cannot be saved. R may already have
changed variables before interruption, so inspect working memory before continuing.
If interruption cannot be confirmed, the runtime stops the owned container and
reports the session as unconfirmed until inspected. It never assumes that a
signal canceled a command or automatically reruns source.

Restart explicitly discards unsaved working memory. The server confirms the old
runtime is stopped and verifies the original exact input versions and environment
before creating a fresh session and generation. It reloads those inputs without
replaying earlier commands. The old journal, saved versions, restart receipt, and
link to the replacement remain available. Repeating the same restart request
inspects its recorded result instead of starting another session. Restore marks
unfinished restart receipts unconfirmed; it does not resume them automatically.

New setup selects `EXPERT_R_ACCESS_POLICY=project-roles`: project owners, admins,
and analysts can run their own saved analyses without an individual operator
grant. Viewers and anonymous demo guests cannot execute R. Existing deployments
without that setting retain `approved-accounts` access. Unknown policies fail
closed. The interface checks authenticated broker capabilities and explains
missing configuration, an unreachable runtime, incompatible profiles, and
revoked access; it does not claim readiness from environment variables alone.

The private R screen displays and downloads the exact environment manifest. New
R submissions and recipe steps pin this manifest by SHA-256; saved recipe snapshots
keep that pin. Successful runs retain a creator-private copy beside their outputs.
Replacing the worker image or changing its package inventory stops a pinned run
with a restoration message. Keep the reviewed image in a registry by immutable
digest, or export its exact local image with `docker save` and transfer it to the
replacement worker with `docker load`.

Verify a downloaded manifest on the replacement worker:

```bash
npm run expert-r:restore-environment -- --manifest environment.json
# Retrieve the recorded immutable registry digest, then verify:
npm run expert-r:restore-environment -- --manifest environment.json --pull
```

`--pull` accepts a recorded registry digest; a local image ID requires the original
saved image. Verification compares the installed R and system package inventory,
R/Bioconductor versions, architecture, and image identity. It fails if the original
image or a dependency is unavailable. It does not install newer packages. The
manifest covers container userspace and records missing package-origin metadata
explicitly; host kernels and hardware are outside that snapshot.

Administrators can explicitly grant or revoke an account in either policy:

```bash
npm run expert-r-access -- grant researcher@example.org
npm run expert-r-access -- status researcher@example.org
npm run expert-r-access -- revoke researcher@example.org
```

Each change is recorded in the operator audit log. An explicit revocation
overrides project roles and prior grants until an administrator grants access
again. Revocation prevents new work and cancels queued Expert R and recipe jobs
before compute contact. Already claimed execution is not forcibly interrupted;
previous durable results remain available. The feature contains the
workload and isolates tenants, but it is not DLP: an authorized researcher can
write data-derived tables and figures and export a bundle after the result is
explicitly published. Do not grant the capability unless that export authority is
acceptable. Packages come only from the pinned image; runtime installation is
unsupported.

Before release, run both Expert R acceptance layers against operator-controlled
local Docker and Postgres:

```bash
npm run test:expert-r-sandbox
DATABASE_URL=postgres://... npm run test:expert-r-browser
# For persistent sessions, use the reviewed immutable local kernel image:
EXPERT_R_SANDBOX_IMAGE=sha256:YOUR_IMAGE_ID npm run test:private-r-kernel
EXPERT_R_SANDBOX_IMAGE=sha256:YOUR_IMAGE_ID npm run test:private-r-console-browser
EXPERT_R_SANDBOX_IMAGE=sha256:YOUR_IMAGE_ID npm run test:large-r-artifacts-browser
```

The first command probes the containment and resource boundary directly. The
second drives the production frontend through authenticated import, a durable
worker claim, the real sandbox, creator-private result publication, an exact
checksum-verified browser download, terminal transport-parameter source erasure
with separate immutable private source retention for new runs, and a path-free
failed-script explanation. Both commands create and remove disposable resources.

Set `EXPERT_R_MIN_FREE_BYTES` for the shared host's operating reserve;
the shipped example uses 1 GiB as a minimum, not a sizing recommendation. A run
is rejected before compute unless both the broker work filesystem and durable
storage can retain that reserve after their worst-case per-run reservations.
The actual writable output is a 200 MiB tmpfs with a bounded inode count, so a
running script cannot fill shared disk before the broker checks its output. Alert
on both filesystems independently and size the reserve for concurrent broker
capacity, archives, database operations, and host recovery needs.
The broker writes a server-owned manifest and matching runtime labels for every
workspace. Startup and a bounded periodic reconciler remove only stale workspaces
whose manifest, root hash, and owned-container labels all match; active, unknown,
malformed, or symlinked entries fail closed and remain for operator review.

Approved users import optional CSV, TSV, text, JSON, or RDS inputs through the
Expert Workbench picker. Tabular files are capped at 25 MiB and RDS at 200 MiB.
These files remain owner/project private, are mounted read-only for selected runs,
and are not arbitrary host filesystem paths. `read_input()` deserializes RDS only
inside the fresh sandbox. `save_workspace()` can retain a derived RDS inside the
private checksummed output bundle; the owner may download and later re-import it
through Expert R. It is never promoted to the trusted guided-analysis checkpoint
graph because that would cross the executable deserialization boundary.

## Supported topology

The supported topology is exactly:

- one TLS reverse proxy on the host;
- one Express web process;
- one single-flight interactive worker for checkpoint attach/fork;
- one private interactive R/Plumber process shared by web and that worker;
- two single-flight heavy-compute workers, each with its own private R process;
- one PostgreSQL 16 instance;
- one database-owner schema/grant initializer and a distinct non-owner runtime login;
- one non-root, one-shot initializer for the two shared storage volumes;
- one persistent project-storage volume and one persistent legacy-vault volume;
- separate on-demand backup and read-only-input restore operations containers.

`deploy/compose.single-host.yml` puts Postgres, three R processes, web, three workers, the
one-shot schema and storage initializers, and operations in one project-scoped network namespace. The
initializer completes the named-volume copy-up before any concurrent consumer starts,
avoiding Docker Desktop's empty-volume mount race without changing the persisted layout.
Only Express port 3000 is published, and
only on host loopback. Postgres, R, and worker health listeners bind only to the
shared container loopback and are not published. The bridge permits outbound
container traffic; restrict egress at the host firewall if policy requires it. A
Postgres advisory locks refuse a second web process or a duplicate owner for any
worker-pool slot. A transaction admission gate caps the shipped topology at
three total claims, of which capability routing reserves two lanes for heavy
compute. Do not add replicas outside these declared slots.

This topology preserves the current private, process-local R semantics. A
collaborator may see durable project metadata and artifacts allowed by RBAC, but
never another user's live R object. Durable jobs use Postgres leases and shared
storage; live interactive operations still use the bounded compatibility proxy.

## Explicit limitations

- No high availability, online failover, multi-host storage, or zero-downtime
  database migration is supported.
- Local named volumes are the supported storage backend. Object storage and a
  public artifact-download API are not implemented.
- Heavy R jobs can run two at a time. Each compute job hydrates its own immutable
  checkpoint into a job-scoped key on one isolated R process. The scientific
  route erases that key before returning; acceptance requires zero hydrated keys
  in both compute runtimes after each batch. Additional jobs queue.
- R outages degrade compute while metadata may remain available. This is
  intentional and visible in readiness.
- Uploaded arbitrary R, packages, shell commands, and executable pipeline code
  are not accepted. Declarative pipeline manifests can only compose modules
  already shipped in the application.
- Separate R processes provide state and failure isolation for reviewed handlers,
  but they are not hostile-code sandboxes. Docker administrators can inspect container
  environment variables and volumes.
- The application does not provide disk encryption. Use encrypted host disks,
  encrypted backup media, and an appropriate database/storage security policy.
- Production registration and legacy private-vault uploads are disabled.
  Project dataset uploads require an owner/admin/analyst role and are bounded per
  request, but there is not yet a durable per-user byte quota. Use filesystem
  quotas/capacity alerts and do not admit untrusted users to this topology.

If those limits do not fit the risk model, do not expose the service to users
until hostile-code sandboxing, managed secrets, object storage, and a reviewed
multi-host design are implemented.

## Host prerequisites

- A dedicated, patched Linux host with Docker Engine and Docker Compose v2.
- DNS and a same-host TLS reverse proxy such as Nginx or Caddy.
- Capacity for the configured limits. The defaults permit roughly 40 GiB of R
  memory across one 16 GiB interactive runtime and two 12 GiB compute runtimes,
  in addition to Postgres/web/worker/operations limits; actual peak use depends on
  dataset size and which Seurat operations run.
- A separate, encrypted backup filesystem or mounted backup target.
- Outbound access while images and R packages are built, or prebuilt images in
  a private registry.

Use a dedicated OS account for deployment. Restrict Docker access: membership in
the Docker group is effectively host-root access.

## Configure secrets and images

Copy `deploy/single-host.env.example` outside the repository, set mode `0600`,
and replace every `change-me` value. Generate four independent values; never
reuse a session secret, R service token, database password, or deployment epoch.

```bash
sudo install -d -m 0750 /etc/traceomics /srv/traceomics-backups
sudo cp deploy/single-host.env.example /etc/traceomics/traceomics.env
sudo chmod 0600 /etc/traceomics/traceomics.env
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 16
sudo chown 10001:10001 /srv/traceomics-backups
```

Set `FRONTEND_ORIGIN` to the one exact public HTTPS origin. `TRUST_PROXY_HOPS=1`
assumes the app has exactly one trusted reverse-proxy hop. Do not expose port
3000 directly or change its host binding to `0.0.0.0`.

The tag defaults are suitable only for a first local build. For a release,
publish reviewed application and R images to a private registry and set
`APP_IMAGE`, `OPS_IMAGE`, `R_IMAGE`, `NAMESPACE_IMAGE`, and `POSTGRES_IMAGE` to
immutable digests. Record the image digests alongside the release. Do not use a
floating tag as rollback evidence.

Validate the rendered topology before starting it:

```bash
docker compose \
  --env-file /etc/traceomics/traceomics.env \
  -f deploy/compose.single-host.yml \
  --profile operations config --quiet
npm run test:deployment:compose -- /etc/traceomics/traceomics.env
```

The second command additionally checks the security invariants in the rendered
model. CI also boots disposable source and restore stacks and exercises the
actual non-root operations containers through an offline backup, restore,
verification, and restored restart. This is a wiring proof, not a substitute
for a production-sized restore drill on the intended host and storage.
The Compose drill substitutes a tiny authenticated R health service to keep the
full topology drill focused. A separate required CI job builds the production R
Dockerfile with layer caching, verifies its required packages, boots it as the
unprivileged read-only runtime, and proves authenticated health while rejecting
an unauthenticated probe. A release operator must still boot the exact immutable
R image digest on the intended staging host before promotion.

## Build and start

For a local image build:

```bash
docker compose \
  --env-file /etc/traceomics/traceomics.env \
  -f deploy/compose.single-host.yml \
  build web worker worker-compute-1 worker-compute-2 r r-compute-1 r-compute-2 operations

docker compose \
  --env-file /etc/traceomics/traceomics.env \
  -f deploy/compose.single-host.yml \
  up -d namespace-anchor postgres
```

Production network signup is always closed. Provision the initial owner (and
later accounts) with the operations image. `-T` is required so the CLI receives
non-TTY stdin and refuses an echoed terminal password. The action and target are
recorded in `operator_audit_events`; the password is never accepted in argv or
written to logs.

```bash
read -rsp 'Initial account password: ' TRACEOMICS_PASSWORD; echo
printf '%s' "$TRACEOMICS_PASSWORD" | docker compose \
  --env-file /etc/traceomics/traceomics.env \
  -f deploy/compose.single-host.yml \
  --profile operations run -T --rm operations \
  scripts/account-admin.js create \
  --email owner@example.org \
  --display-name 'Deployment Owner' \
  --password-stdin
unset TRACEOMICS_PASSWORD

docker compose \
  --env-file /etc/traceomics/traceomics.env \
  -f deploy/compose.single-host.yml \
  up -d r r-compute-1 r-compute-2 worker worker-compute-1 worker-compute-2 web
```

The owner can then create projects and add other already-provisioned accounts
through Collaborators. To rotate an account password and revoke all of its
sessions, use the same hidden-input pattern with
`scripts/account-admin.js reset-password --email user@example.org --password-stdin`.
Users who know their current password can instead use Account security in the
application. Self-service changes are atomic with an append-only
`account_security_events` record, revoke every older cookie, and issue a fresh
cookie to the requesting browser. New and reset credentials use the same
15-character minimum and common/repetitive/account-derived password checks;
long passphrases do not require mixed character classes. Existing credentials
remain valid until changed or reset. There is no email verification or network
password-recovery flow in this release, so keep a tested operator recovery path.
Grant/revoke/status operations for `pipeline_registry.publish` use
`scripts/manage-platform-developer.js` in the same operations image; mutations
are recorded in `operator_audit_events`.

For registry images pinned by digest, pull the reviewed images and omit
`build`. The one-shot `schema-init` service uses `POSTGRES_USER` to apply the
exact schema contract, creates/rotates `APP_DATABASE_USER`, and grants runtime
DML/sequence/function privileges without schema creation or table ownership.
Web and workers receive only `APP_DATABASE_USER` and verify the schema contract;
they cannot apply DDL. Keep the two passwords independent. Production validation runs before storage directories or sockets are
created and refuses weak secrets, insecure cookies/origins, invalid proxy
settings, overlapping roots, unsafe Postgres TLS, or unsupported R topology.

Check the private listener from the host:

```bash
curl --fail --silent --show-error http://127.0.0.1:3000/livez
curl --fail --silent --show-error http://127.0.0.1:3000/readyz
```

`/livez` only answers whether the web process is alive. `/readyz` verifies
Postgres, both writable storage roots, and the singleton topology lock. It also
reports `components.rCompute`. If only R is down, readiness remains HTTP 200
with `computeDegraded: true` so users may still reach durable metadata; the R
and worker container health checks will report the compute outage separately.
During graceful shutdown, readiness changes to HTTP 503 before the listener is
closed. Concurrent readiness probes are coalesced and briefly cached, but these
operational endpoints should still be restricted at the proxy.

## Optional server-resident data imports

This feature lets researchers snapshot files already on the selected analysis
server into private artifact versions, then inspect or select them as inputs to
private R. Server-side copies avoid a download/upload round trip through a laptop.
The original source stays read-only, and its later modification does not alter an
existing saved version. Imports are disabled by default and unavailable in public
or demo deployments.

Choose an existing dedicated data directory outside the application checkout,
managed storage, vault, home directories, and credential/system directories.
On Linux, the web container's `APP_UID:APP_GID` must be able to read files and
traverse their ordinary parent directories. Sources must be regular files;
symbolic links and files with multiple hard links are rejected. Do not mount the
host filesystem, a home directory, or a credentials directory as an import source.

Access requires both current project membership and an exact account/project
grant in the operator's root configuration. Being a project administrator does
not grant access to other accounts' private imports or arbitrary host paths.
Resolve the provisioned account's numeric ID and the project's actual ID from
the deployment database; do not substitute an email, display name, or organization
ID. The account-administration CLI reports the account ID when provisioning it.
An operator can also inspect existing memberships with this read-only inventory:

```bash
docker compose \
  --env-file /etc/traceomics/traceomics.env \
  -f deploy/compose.single-host.yml \
  exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT u.id AS account_id,u.email,p.id AS project_id,p.name AS project_name,pm.role
    FROM project_members pm JOIN users u ON u.id=pm.user_id
    JOIN projects p ON p.id=pm.project_id ORDER BY p.id,u.id;
  "'
```

For example, if the dedicated host parent is `/srv/traceomics-import`, its study
folder is `/srv/traceomics-import/study-a`, and the reviewed account/project IDs
are `1` and `proj_replace_me`, set the following in the operator-only environment
file. Replace those example IDs with the inventory results before enabling it:

```dotenv
SERVER_DATA_IMPORT_SOURCE=/srv/traceomics-import
SERVER_DATA_IMPORT_ROOTS='[{"id":"study-a","label":"Study A data","path":"/server-data/study-a","grants":[{"projectId":"proj_replace_me","ownerUserId":1}]}]'
```

The JSON `path` is the container path. Add a separate grant for each intended
account/project pair; `ownerUserId` must be a JSON number. Roots need distinct
IDs and dedicated, non-overlapping directories. Users see only root labels and
relative filenames, never absolute host paths.

Enable the explicit overlay for the web service:

```bash
docker compose \
  --env-file /etc/traceomics/traceomics.env \
  -f deploy/compose.single-host.yml -f deploy/compose.server-data.yml \
  config --quiet

docker compose \
  --env-file /etc/traceomics/traceomics.env \
  -f deploy/compose.single-host.yml -f deploy/compose.server-data.yml \
  up -d web
```

Keep both Compose files in subsequent commands for this installation. The overlay
adds one read-only bind at `/server-data` to web only; R runtimes, workers, the
sandbox broker, and operations containers receive no original data mount. A missing
host source fails instead of creating a directory. The base deployment remains
unchanged when the overlay is omitted. Remove grants to revoke new source access;
saved private snapshots remain retained under their existing artifact permissions.

For a directly managed local web service, set `SERVER_DATA_IMPORT_ROOTS` to actual
absolute directories on that host and restart it. Compose source paths are not
needed outside containers. The browser and desktop client use the service currently
open in the workspace; SSH connection settings do not grant data-folder access.

Server imports use `PRIVATE_R_MAX_INPUT_FILE_BYTES` (512 MiB default), the shared
`PRIVATE_R_MANAGED_QUOTA_BYTES` budget (5 GiB per account/project), and 200 managed
versions. Pending imports and private R saves reserve quota. Admission checks
durable disk space and the configured `PRIVATE_R_DISK_RESERVE_BYTES`, then bounds
the snapshot by `PRIVATE_R_TRANSFER_TIMEOUT_SECONDS` (900 seconds default). At most
two imports per account and four across the installation are active. Directory
responses contain at most 100 entries and examine at most 10,000 entries; arrange
larger sources into smaller subdirectories. Existing browser-preview and private-R
memory/input limits continue to apply.

After enabling access, verify **Runs & Results → Inspect or import artifact files
→ Browse server data** with the intended account. Import a file and check the
saved checksum, relative source, server label, and optional sample details. Refresh
the private R console to select the exact new input version. Imported RDS files
remain isolated private inputs and are never deserialized by the shared guided R
service. An accepted import continues through client disconnect; **Check server
import status** inspects its original request without submitting it again. A web
process restart or expired deadline leaves unfinished requests failed or pending
until expiry; sources are never automatically replayed. User workflow details are
in [analysis-workflows.md](analysis-workflows.md#import-data-already-on-the-selected-server).

## Windows desktop application

`npm run desktop:dist:unsigned` builds an unsigned Windows NSIS installer for
local acceptance. `npm run desktop:dist` is release-only: it requires the
electron-builder signing credential variables and refuses to produce an unsigned
release artifact. Output uses the stable
`TraceOmics-Setup-<version>-x64.exe` name. The manual Release Certification
workflow verifies the Authenticode publisher, product/company metadata, and
SHA-256 before uploading the installer and checksum sidecar.

The installed application is a sandboxed Electron client for the same HTTPS
deployment; it does not bundle or start Postgres, R, or Docker. Operators can
embed the first server URL with `TRACEOMICS_DESKTOP_URL` at build time, or users
can enter it on the setup screen. The client checks the bounded public
`/api/service/compatibility` descriptor through the selected connection before
saving the address. The descriptor contains the product and supported service
and client API versions, without runtime or account details. Services that lack
this endpoint require an update. Automatic in-app updating is
not configured; distribute each update as a new signed installer and keep the
application version current before certification.

Use **Execution Targets** in the desktop menu, or **Change server** in the
workspace, to save named local and HTTPS servers. Each server has separate
cookies and browser storage, including local servers on different ports.
Returning to a server preserves its own session. The workspace displays the
connected server and its current custom R availability. A failed connection
leaves the previous server open. Existing saved server addresses migrate
automatically; `TRACEOMICS_DESKTOP_URL` still selects the startup server.

After signing in, open **Connection details → Check server readiness** to inspect
the selected server. The report distinguishes guided R and its packages, observed
queued-worker availability, the exact custom R environment, configured resource
ceilings, and writable storage with observed free space. External schedulers are
currently unsupported. **Check again** refreshes the observations; an explicit
stale notice appears when their short lifetime expires. These checks do not start
scientific work, reserve capacity, or establish that a particular dataset fits.
Execution checks access and admission again.

The authenticated `/api/runtime/readiness?projectId=...` response checks current
membership and R execution access on every request. Shared dependency probes are
bounded and briefly cached, while private environment, resource and storage
details are withheld when execution access is absent or revoked. Raw host paths,
credentials, worker identities and service errors are excluded. Missing packages,
service authentication failures, storage pressure and unavailable workers include
specific remediation in the report. Transport and certificate failures remain in
the connection workflow, which preserves the previous workspace when a candidate
server fails verification.

SSH profiles can verify access through the system OpenSSH client, agent, and
configuration. Leave username or port blank to use the configured values, or
choose an identity reference through the native file picker. The application
stores a file reference and public host trust; keys and passphrases stay with
OpenSSH. Encrypted identities must be unlocked in a running native SSH agent.
On Windows, **Unlock with OpenSSH** opens a native OpenSSH credential window.

Native aliases and `ProxyJump` chains are supported with up to four jump hosts.
Define each host's account, port, and identity in your own OpenSSH configuration;
the profile can leave account and port blank. The managed check preserves these
settings and enforces strict host verification separately at every hop. Trust new
jump hosts in the native OpenSSH client before continuing; the destination's
first-use fingerprint can then be discovered through the verified chain without
sending destination credentials. Changing an alias or intermediate configuration
invalidates a pending trust confirmation. Failures identify the affected hop.
Temporary route policy files and owned proxy processes are removed on cancellation
or settings shutdown.

For a new host, compare the displayed SHA-256 fingerprint with an independently
verified administrator-provided value before trusting it. Changed keys stop
authentication; verify the change before editing the native host trust file.
The check requires permission to run the noninteractive command `true` on the
remote host. Cancelling the check closes its owned SSH process. Missing clients,
unavailable identities, authentication failures, and unreachable hosts have
separate remediation messages.

To connect the application through SSH, enter its original HTTPS URL and the
HTTPS ingress port on the remote host's loopback interface. The desktop starts
one owned local forward through the verified account and jump chain, checks the
application, then opens that server. The original HTTPS hostname and port remain
the browser origin, so its certificate, secure session cookies, and CSRF policy
are verified normally. Private certificate authorities must already be trusted
by the operating system. SSH profiles without an application URL remain usable
for configuration and authentication checks.

Only the configured application's HTTPS authority can pass through the managed
proxy. R, Postgres, arbitrary remote hosts, and unrelated forwards in native
configuration are not exposed. Each resolved remote account/server route has
separate browser storage. Closing the workspace or changing servers removes its
owned tunnel. A failed candidate connection preserves the previous workspace;
an established tunnel loss appears in the server indicator and requires explicit
reconnection through server settings. It never moves analysis work to the laptop
automatically. Server-side jobs continue under their normal lifetime and quotas.

## TLS reverse proxy

The proxy must terminate TLS, replace (not append untrusted values to) all
forwarding headers, preserve the Host, and forward only to host loopback. The
proxy also supplies an independent auth limiter, connection bound, and private
health-route policy. For example, put the zones in the Nginx `http` scope and
the shared proxy directives in `/etc/nginx/snippets/traceomics-proxy.conf`:

```nginx
# http scope
limit_req_zone $binary_remote_addr zone=traceomics_auth:10m rate=5r/m;
limit_conn_zone $binary_remote_addr zone=traceomics_clients:10m;

# /etc/nginx/snippets/traceomics-proxy.conf
proxy_pass http://127.0.0.1:3000;
proxy_set_header Host $host;
proxy_set_header Forwarded "";
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Port 443;

server {
    listen 443 ssl;
    server_name traceomics.example.org;

    # Match this to the reviewed MAX_UPLOAD_BYTES policy.
    client_max_body_size 512m;
    client_body_timeout 60s;
    proxy_read_timeout 130s;
    limit_conn traceomics_clients 8;

    # Production signup is operator-only. Drop it again at ingress.
    location = /api/auth/signup { return 404; }

    location = /api/auth/login {
        limit_req zone=traceomics_auth burst=5 nodelay;
        include /etc/nginx/snippets/traceomics-proxy.conf;
    }

    # Permit only same-host monitoring by default. Add explicit monitoring
    # source addresses if required; do not make readiness a public endpoint.
    location = /livez {
        allow 127.0.0.1;
        allow ::1;
        deny all;
        include /etc/nginx/snippets/traceomics-proxy.conf;
    }
    location = /readyz {
        allow 127.0.0.1;
        allow ::1;
        deny all;
        include /etc/nginx/snippets/traceomics-proxy.conf;
    }

    location / {
        include /etc/nginx/snippets/traceomics-proxy.conf;
    }
}
```

Configure the certificate, modern TLS policy, HTTP-to-HTTPS redirect, request
logging, and log retention in the proxy. Express refuses non-health production
requests unless the trusted proxy marks them HTTPS. Behind trusted HTTPS it sets
a `__Host-` HttpOnly/Secure/SameSite session cookie, HSTS, CSP, frame denial,
MIME sniffing protection, and a no-referrer policy.

## Sessions and secret rotation

Browser authentication is cookie-only. Bearer credentials are rejected and the
frontend removes pre-upgrade localStorage bearer values. Users upgrading from a
pre-cookie-only release must sign in once.

Each signed session carries the user's database-backed session version and
`SESSION_EPOCH`. Logout
increments that version atomically and therefore logs that account out on every
browser/device. A database failure returns 503 instead of reporting false
revocation success.

- Keep `SESSION_SECRET` stable across routine restarts. Rotating it immediately
  invalidates every session, which is appropriate for suspected compromise.
- Keep `SESSION_EPOCH` stable across routine restarts, but generate a new
  `openssl rand -hex 16` value for every restore candidate. Restore refuses the
  epoch recorded in the backup so pre-restore cookies cannot become valid again.
- Rotate `R_API_TOKEN` by updating the env file and restarting R, web, and worker
  together. It is an internal capability and must never be browser-visible.
- Rotate the Postgres password in a coordinated maintenance window and update
  both Postgres and client configuration. Test the new credentials before
  discarding the old recovery path.
- Treat a copied env file as a secret incident. Docker Compose environment files
  are not a managed-secret system.

## Offline backup

The application cannot create an atomic online snapshot across Postgres and two
filesystem roots. A supported backup is therefore offline with respect to every
application writer: stop web, every worker, and every R runtime first, while leaving Postgres and the
namespace anchor running.

```bash
docker compose \
  --env-file /etc/traceomics/traceomics.env \
  -f deploy/compose.single-host.yml \
  stop web worker worker-compute-1 worker-compute-2 r r-compute-1 r-compute-2

docker compose \
  --env-file /etc/traceomics/traceomics.env \
  -f deploy/compose.single-host.yml \
  --profile operations run --rm operations \
  scripts/backup-runtime.js \
  --destination /app/backups/backup-2026-07-16T120000Z \
  --confirm-offline I_CONFIRM_WRITES_ARE_STOPPED
```

The destination must be a new directory outside both data roots. The command
uses a custom-format `pg_dump`, copies both roots without following links, and
writes exact SHA-256/size inventories plus a manifest. It refuses filesystem
roots, path overlap, links/junctions, special files, non-portable names,
case-colliding paths, and a destination that already exists. Database
credentials are passed through libpq environment variables, never process
arguments.

The manifest detects corruption; it is not a cryptographic signature against a
malicious operator who can replace both payload and manifest. Store completed
packages on trusted immutable/WORM media or sign them with an independently
managed system before transfer. Restore mounts this input read-only and seals
the exact validated database dump inside the target volume before `pg_restore`.

Move the completed package to encrypted, access-controlled storage on another
failure domain. Do not count an on-host package as disaster recovery. Then
restart and check health:

```bash
docker compose \
  --env-file /etc/traceomics/traceomics.env \
  -f deploy/compose.single-host.yml \
  up -d r r-compute-1 r-compute-2 worker worker-compute-1 worker-compute-2 web
```

If backup fails, preserve its error output for the operator, remove only the
incomplete destination after verifying its absolute path, and repeat the whole
offline operation. Never hand-edit a backup package or manifest.

## Restore and verification

Always restore into a new Compose project, an empty Postgres database, and new
or empty storage roots. Never restore over a running deployment. The restore
command deliberately does not use `pg_restore --clean`.

For a drill on the same host, copy the env file, set an unused `WEB_PORT` (for
example 3001), and replace `SESSION_EPOCH` with a new `openssl rand -hex 16`
value before starting any candidate service. The restore tool compares it with
the epoch recorded in the backup and refuses reuse before mutating the target.
This prevents old browser cookies from resurrecting. A separate host is
preferable.

```bash
docker compose -p traceomics-restore \
  --env-file /etc/traceomics/restore.env \
  -f deploy/compose.single-host.yml \
  up -d namespace-anchor postgres

docker compose -p traceomics-restore \
  --env-file /etc/traceomics/restore.env \
  -f deploy/compose.single-host.yml \
  --profile operations run --rm restore-operations \
  scripts/restore-runtime.js \
  --backup /app/backups/backup-2026-07-16T120000Z \
  --storage-root /app/storage-volume/data \
  --vault-root /app/vault-volume/vault \
  --confirm-offline I_CONFIRM_WRITES_ARE_STOPPED

docker compose -p traceomics-restore \
  --env-file /etc/traceomics/restore.env \
  -f deploy/compose.single-host.yml \
  --profile operations run --rm restore-operations \
  scripts/verify-backup-restore.js \
  --backup /app/backups/backup-2026-07-16T120000Z \
  --storage-root /app/storage-volume/data \
  --vault-root /app/vault-volume/vault
```

Restore validates the package, stages filesystem trees as siblings inside each
writable named-volume parent, seals the database archive, promotes and verifies
both roots, then restores Postgres in one transaction. Verification checks both exact inventories, current
dataset/artifact database references, sizes, and checksums. The automated real
drill also compares every source/restored public-table row fingerprint except
for the deliberate active-job security delta. Every restored `queued` or
`running` job is changed to `canceled`, receives a recovery log entry, and has
its worker, claim, lease, heartbeat, and lock fields cleared. Already-terminal
job history and artifacts are preserved exactly.

Legacy rows that only contain old `storage_uri`/analysis-object references do
not have a uniform root-relative mapping. Their vault bytes are still covered
by the exact inventory, and the verifier reports their counts, but it cannot
prove each legacy DB-to-file mapping. Treat a nonzero legacy count as a manual
inspection requirement before cutover.

No tool can make two filesystems and Postgres one atomic transaction. If any
restore step fails after a root is promoted, the command reports
`RESTORE_CANDIDATE_INVALID`. Destroy and recreate the entire isolated candidate
database and both named volumes before retrying; never attempt to complete or
reuse a partial candidate in place.

The recovery point also rolls the database back. A new `SESSION_EPOCH` protects
cookies, but it does not undo restored password hashes, memberships, owner/admin
roles, or `pipeline_registry.publish` grants. Keep web, worker, and R stopped
after restore while a second operator compares the candidate with authoritative
off-system access records. At minimum review these read-only inventories:

```bash
docker compose -p traceomics-restore \
  --env-file /etc/traceomics/restore.env \
  -f deploy/compose.single-host.yml \
  exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT id,email,display_name,session_version,created_at FROM users ORDER BY email;
    SELECT pm.project_id,u.email,pm.role FROM project_members pm JOIN users u ON u.id=pm.user_id ORDER BY 1,2;
    SELECT om.organization_id,u.email,om.role FROM organization_members om JOIN users u ON u.id=om.user_id ORDER BY 1,2;
    SELECT u.email,pc.capability FROM platform_capabilities pc JOIN users u ON u.id=pc.user_id ORDER BY 1,2;
    SELECT id,status,worker_id,claim_token,lease_expires_at FROM jobs ORDER BY created_at,id;
  "'
```

Reset every privileged account whose restored password should no longer be
accepted before starting web. This increments that user's session version and
records an append-only operator audit event:

```bash
read -rsp 'Replacement password: ' TRACEOMICS_PASSWORD; echo
printf '%s' "$TRACEOMICS_PASSWORD" | docker compose -p traceomics-restore \
  --env-file /etc/traceomics/restore.env \
  -f deploy/compose.single-host.yml \
  --profile operations run -T --rm operations \
  scripts/account-admin.js reset-password \
  --email user@example.org \
  --password-stdin
unset TRACEOMICS_PASSWORD
```

Reconcile `pipeline_registry.publish` while the application remains stopped.
The operations image contains the reviewed capability CLI; grant/revoke actions
are transactional and append an operator audit event:

```bash
docker compose -p traceomics-restore \
  --env-file /etc/traceomics/restore.env \
  -f deploy/compose.single-host.yml \
  --profile operations run -T --rm operations \
  scripts/manage-platform-developer.js revoke former-developer@example.org
```

Project membership changes use the same role-checked Collaborators UI as a live
deployment. They must be made in a private web-only reconciliation phase; this
is not permission to expose the candidate publicly:

1. Set a unique unused `WEB_PORT` and a private HTTPS `FRONTEND_ORIGIN` in
   `restore.env`. Do not add this candidate to public DNS or the production
   reverse-proxy upstream.
2. Start only `web` (Postgres and the namespace anchor are already running).
   Keep `worker` and `r` stopped, so no recovered job or R state can execute.
3. Put an operator-only TLS proxy in front of the candidate loopback port. Bind
   it to loopback or an administrative interface protected by firewall/mTLS,
   and reach it through an SSH tunnel if the operator is remote. It must set the
   same forwarding headers and limits as the Nginx example above.
4. Sign in using a just-reset owner account, reconcile each project's members
   and roles in Collaborators, then repeat the SQL inventory and obtain a second
   operator signoff.
5. Stop `web` again before final acceptance and public cutover.

```bash
docker compose -p traceomics-restore \
  --env-file /etc/traceomics/restore.env \
  -f deploy/compose.single-host.yml \
  up -d web

# After private reconciliation and the repeated inventory:
docker compose -p traceomics-restore \
  --env-file /etc/traceomics/restore.env \
  -f deploy/compose.single-host.yml \
  stop web
```

The current release has no supported organization-membership mutation surface.
If the organization inventory differs from the authoritative record, reject the
candidate and use a newer recovery point or a separately reviewed, versioned
data migration; do not repair it with ad-hoc SQL. Record reconciliation and both
operator approvals outside the recovered database. Do not start compute or add
the candidate to public routing until this review is complete.

After verification and security reconciliation, keep the public reverse proxy
on the old deployment and change `FRONTEND_ORIGIN` in `restore.env` from the
private reconciliation origin to the exact final public HTTPS origin. Retain the
candidate's unique `WEB_PORT`. Validate the resulting topology, then force a web
recreation so the private origin cannot remain accepted accidentally. Record
this origin transition with the reconciliation signoff.

Start the candidate stack, check health, sign in through a test account using
the final hostname through a non-public acceptance route (for example a staging
proxy or local host override), create/read a disposable project, and exercise
the intended R workflow before changing the public reverse proxy:

```bash
docker compose -p traceomics-restore \
  --env-file /etc/traceomics/restore.env \
  -f deploy/compose.single-host.yml \
  config --quiet

npm run test:deployment:compose -- /etc/traceomics/restore.env

docker compose -p traceomics-restore \
  --env-file /etc/traceomics/restore.env \
  -f deploy/compose.single-host.yml \
  up -d --force-recreate r r-compute-1 r-compute-2 worker worker-compute-1 worker-compute-2 web

curl --fail --silent --show-error http://127.0.0.1:3001/readyz
```

Do not make the candidate public merely to perform acceptance. Switch the
production reverse-proxy upstream only after these checks pass; the browser
origin used for acceptance must already match the final `FRONTEND_ORIGIN`.

Retain the old deployment and backup until application acceptance is complete.
Destroying old volumes is an explicit operator decision, not part of the restore
tool.

## RPO, RTO, and drills

- Recovery point objective: the most recent completed, off-host, verified
  offline backup. There is no point-in-time recovery in this template.
- Recovery time objective: image pull/build time plus database restore, file
  copy, verification, and UI acceptance time. It depends on actual data size and
  must be measured; the repository does not promise a universal duration.
- Run an isolated restore drill on a schedule and after storage/schema changes.
  `npm run test:backup-restore:real` is a small CI proof, not a substitute for a
  production-sized drill.

Choose backup frequency from the maximum acceptable data loss. Monitor backup
age, package size, available destination capacity, and drill results.

## Operations and upgrades

Monitor at minimum:

- public TLS/proxy availability and certificate expiry;
- web `/livez` and `/readyz` payloads;
- worker and R container health;
- Postgres connections, storage growth, and backup age;
- filesystem capacity/quota headroom for uploads and temporary staging;
- host/container memory, especially R RSS and OOM events;
- queued/running/failed durable-job counts and lease recovery;
- repeated auth-rate-limit, CSRF, startup-refusal, and sanitized worker errors.

Container stdout/stderr is the current log surface. Configure a host logging
driver with access control, retention, capacity limits, and alerting. Public HTTP
errors and selected worker records use stable sanitized messages, but operational
Node/R logs can contain internal paths and raw dependency diagnostics. Treat all
logs as sensitive and do not grant ordinary users access.

Before an upgrade: run CI, take and verify an offline backup, record image
digests, and test the release against an isolated restore. The schema changes in
this repository are additive, but an application rollback is not a database
rollback. If a new release writes data an old release cannot safely interpret,
restore the verified backup into a fresh stack instead of mutating live volumes.

The deployment is a credible single-host starting point only while these
documented constraints are accepted. Multi-host/HA, elastic compute,
untrusted arbitrary code outside the opt-in Expert R sandbox, and managed hosted
infrastructure require separate architecture work.

## Isolated public demo deployment

The website demo is a separate deployment, database, storage namespace, session
secret, R token, deployment epoch, and Compose project. It must never be an
ingress route to a private lab deployment. Start it by layering
`deploy/compose.demo.yml` over the single-host topology with a fixed distinct
project name such as `traceomics-demo` and a demo-only env file.

`DEMO_TEMPLATE_PROJECT_ID` must identify an operator-reviewed canonical Seurat
checkpoint already present in the demo database/storage. Starting a demo session
creates a random non-login guest identity, a private project, and a verified copy
of that immutable checkpoint. The server also remaps the exact canonical object's
conditions, bound biological samples, and immutable contrast snapshots into the
guest project in the same transaction. Source IDs are not reused and dataset
foreign keys are cleared, so guest metadata cannot refer back to the template
tenant. Guest sessions expire after
`DEMO_GUEST_TTL_SECONDS`. Dataset uploads and Expert R are blocked in both the UI
policy and server routes. Heavy scientific jobs are limited to one active job per
guest and two across the deployment.

Run `npm run test:demo-compose` for a destructive-only-to-its-own-randomized-
Compose-project acceptance. It creates a reviewed synthetic template, drives a
real Chromium guest through checkpoint hydration, rendered UMAP, and exploratory
analysis, then verifies guest isolation, checkpoint copying, policy gates, rate
and compute limits, and selective expiry cleanup. The harness creates and removes
its own database/storage volumes and must not be pointed at an existing project.

Run `npm run test:private-compute-compose` to retain sanitized concurrency,
third-job queueing, zero-post-job-state, scientific-worker, collaboration,
controlled-export, and append-only-audit evidence under
`playwright/report/release-acceptance/`. The report intentionally omits raw R
state keys, runtime identities, and user/project identifiers.

On Windows, `npm run test:native-ui-compose` creates a separate randomized
private stack, drives a real Chromium session and two distinct Electron profile
directories, proves the two DEG jobs overlap on different R runtime identities,
and writes screenshots plus an MJPEG AVI under
`playwright/report/release-acceptance/`. Native capture uses each Electron
`BrowserWindow` handle with `PrintWindow`; it never records the desktop or an
arbitrary foreground rectangle. The harness removes its containers and volumes
after completion.

For a release candidate, manually dispatch `.github/workflows/release-certification.yml`.
It groups the expensive private-browser, Expert R, demo, multi-sample, spatial,
and Windows-installer checks into one explicit release gate. Enable the optional
native input only when the labeled self-hosted Windows/Docker runner is online.
It intentionally
does not run on every push; ordinary pull requests still use the normal CI
pipeline, while a release tag or deployment must cite one passing certification
run for the exact commit.

Run `docker compose -p traceomics-demo --env-file deploy/demo.env -f
deploy/compose.single-host.yml -f deploy/compose.demo.yml --profile demo-ops run
--rm demo-cleanup` from an operator scheduler at least every ten minutes. Cleanup
removes expired guest storage through the validated project-storage provider and
then deletes the guest's project metadata in one transaction. The curated
template project is never selected by this cleanup because it is not a demo guest
project. Treat a failed cleanup run as an operational alert.

### Free-tier ARM64 deployment candidate

The checked-in free-tier candidate targets one Ubuntu ARM64 VM with two OCPUs and
12 GB of memory. Oracle Cloud's Always Free Ampere allowance currently describes
that equivalent allocation, but instance capacity is not guaranteed and the
allowance is tied to the account's home region. Confirm the current provider
terms before relying on it:

- <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>
- <https://docs.oracle.com/iaas/Content/FreeTier/freetier.htm>

Oracle also documents that it may reclaim an Always Free compute instance it
classifies as idle over a seven-day period. Do not generate artificial workload
to evade that policy. Treat the public demo URL as best-effort, keep the
deployment reproducible from this repository, retain the curated-template
backup, and expect that an operator may need to reprovision the VM.

This is a demonstration profile, not a free research-compute service. The fixed
limits in `deploy/compose.demo-free-tier.yml` are sized only for the bundled
800-cell synthetic tutorial and leave host memory headroom. They do not make a
12-GB VM suitable for uploaded studies; uploads are disabled. Keep OCI ingress
limited to TCP 80/443 plus SSH from a trusted administrator address. Do not open
port 3000, Postgres, or an R port.

Install Docker Engine and the Compose plugin from
<https://docs.docker.com/engine/install/ubuntu/>, then copy the repository and
create the operator files:

```bash
sudo install -d -m 0750 /etc/traceomics /srv/traceomics-demo-backups
sudo cp deploy/demo-free-tier.env.example /etc/traceomics/demo.env
sudo chmod 0600 /etc/traceomics/demo.env
sudo chown 10001:10001 /srv/traceomics-demo-backups
```

Set `PUBLIC_HOST` and `FRONTEND_ORIGIN` to one hostname resolving to the VM. A
domain you control is preferred. For a disposable demonstration, a hostname such
as `203-0-113-10.sslip.io` resolves through <https://sslip.io/>; do not use
it as an availability dependency for a private/research deployment. Caddy needs
the public hostname to resolve correctly and ports 80/443 reachable so it can
obtain and renew HTTPS certificates; see
<https://caddyserver.com/docs/automatic-https>. The edge deliberately returns 404 for
`/livez`, `/readyz`, and `/api/auth/signup`; operators can probe the loopback-only
web port over SSH.

Replace every `change-me` value with independent secrets. The hex lengths in the
example are minimum formats, not literal values:

```bash
openssl rand -hex 32  # SESSION_SECRET
openssl rand -hex 16  # SESSION_EPOCH
openssl rand -hex 32  # R_API_TOKEN
openssl rand -base64 32  # POSTGRES_PASSWORD
```

Build the exact ARM64 images on the target host, render the final topology, and
start only the namespace, storage initializer, and database for template
creation:

```bash
COMPOSE='docker compose -p traceomics-demo --env-file /etc/traceomics/demo.env -f deploy/compose.single-host.yml -f deploy/compose.demo.yml -f deploy/compose.demo-free-tier.yml'
$COMPOSE build web r operations
$COMPOSE --profile demo-bootstrap config --quiet
npm run test:deployment:compose -- /etc/traceomics/demo.env
$COMPOSE up -d namespace-anchor postgres storage-init
```

The template bootstrap is intentionally three explicit operations. The first
creates server-owned metadata and a pending record, the R step writes a synthetic
Seurat checkpoint, and finalization verifies the file before review, approval,
and canonical promotion. None of the commands accepts a local input dataset:

```bash
$COMPOSE --profile demo-bootstrap run --rm demo-template-prepare
$COMPOSE --profile demo-bootstrap run --rm demo-template-r
$COMPOSE --profile demo-bootstrap run --rm demo-template-finalize
```

Copy the exact `proj_*` printed by finalization into
`DEMO_TEMPLATE_PROJECT_ID`, rerun `config --quiet`, and start the public services:

```bash
$COMPOSE --profile demo-ops config --quiet
$COMPOSE up -d --wait --wait-timeout 300 \
  r r-compute-1 r-compute-2 web worker worker-compute-1 worker-compute-2 caddy
curl --fail --silent http://127.0.0.1:3001/readyz
curl --fail --silent https://"$PUBLIC_HOST"/api/auth/policy
```

The shell variable and `PUBLIC_HOST` must be set again after a new SSH login; the
authoritative values remain in `/etc/traceomics/demo.env`. Confirm that the policy
reports demo mode, uploads disabled, and Expert R disabled. Then run the real
browser workflow against the public HTTPS origin before announcing the site:

```bash
PUBLIC_DEMO_ORIGIN=https://"$PUBLIC_HOST" npm run test:demo-browser
```

This final run creates one normal expiring guest and retains its screenshots and
Playwright video under `playwright/report/release-acceptance/`; do not substitute
the loopback URL used by the disposable Compose harness.

Schedule cleanup at least every ten minutes. For example, place the full Compose
command in a root-owned wrapper with mode `0750`, lock it with `flock` so runs
cannot overlap, and invoke this operation from a systemd timer:

```bash
$COMPOSE --profile demo-ops run --rm demo-cleanup
```

Alert on a nonzero exit, low disk space, unhealthy containers, certificate
renewal errors, or repeated HTTP 429/5xx responses. Back up the curated template
and configuration using the same offline procedure as the private topology; the
ephemeral guest projects are not recovery objectives. Pin the reviewed Node, R,
Postgres, Alpine, and Caddy images by digest after the on-host build/boot proof.
The current Rocker R base and official Caddy images publish ARM64 variants (see
<https://hub.docker.com/r/rocker/r-ver/tags> and
<https://hub.docker.com/_/caddy>), but that must be rechecked for the exact
release tags/digests on the deployment day.
