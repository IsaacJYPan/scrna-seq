# Supported Single-Host Deployment

This document describes the deployment shape that this repository supports and
tests today. It is a conservative deployment candidate for a Linux host with
Docker Compose. It is not a claim of high availability, elastic R scaling, or
hard multi-tenant compute isolation.

The supported exposure model is a trusted lab/team whose accounts are
provisioned by the host operator. It is not an anonymous-signup service or a
hostile-user multi-tenant SaaS boundary.

## Supported topology

The supported topology is exactly:

- one TLS reverse proxy on the host;
- one Express web process;
- one standalone durable-job worker with one in-flight job;
- one private R/Plumber process shared by web and worker;
- one PostgreSQL 16 instance;
- one persistent project-storage volume and one persistent legacy-vault volume;
- separate on-demand backup and read-only-input restore operations containers.

`deploy/compose.single-host.yml` puts Postgres, R, web, worker, and operations in
one project-scoped network namespace. Only Express port 3000 is published, and
only on host loopback. Postgres, R, and worker health listeners bind only to the
shared container loopback and are not published. The bridge permits outbound
container traffic; restrict egress at the host firewall if policy requires it. A
Postgres advisory lock refuses a second web process, and the worker has its own
single-replica/admission fences. Do not scale either service horizontally.

This topology preserves the current private, process-local R semantics. A
collaborator may see durable project metadata and artifacts allowed by RBAC, but
never another user's live R object. Durable jobs use Postgres leases and shared
storage; live interactive operations still use the bounded compatibility proxy.

## Explicit limitations

- No high availability, online failover, multi-host storage, or zero-downtime
  database migration is supported.
- Local named volumes are the supported storage backend. Object storage and a
  public artifact-download API are not implemented.
- R is one memory-heavy process. Jobs queue; they do not run concurrently.
- R outages degrade compute while metadata may remain available. This is
  intentional and visible in readiness.
- Uploaded arbitrary R, packages, shell commands, and executable pipeline code
  are not accepted. Declarative pipeline manifests can only compose modules
  already shipped in the application.
- Containers reduce accidental exposure, but this topology is not a per-job
  sandbox for hostile R code. Docker administrators can inspect container
  environment variables and volumes.
- The application does not provide disk encryption. Use encrypted host disks,
  encrypted backup media, and an appropriate database/storage security policy.
- Production registration and legacy private-vault uploads are disabled.
  Project dataset uploads require an owner/admin/analyst role and are bounded per
  request, but there is not yet a durable per-user byte quota. Use filesystem
  quotas/capacity alerts and do not admit untrusted users to this topology.

If those limits do not fit the risk model, do not expose the service to users
until isolated per-job compute, managed secrets, object storage, and a reviewed
multi-host design are implemented.

## Host prerequisites

- A dedicated, patched Linux host with Docker Engine and Docker Compose v2.
- DNS and a same-host TLS reverse proxy such as Nginx or Caddy.
- Capacity for the configured limits. The example reserves roughly 26 GiB
  across R, Postgres, web, worker, and operations; actual peak use depends on
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
sudo install -d -m 0750 /etc/benchone /srv/benchone-backups
sudo cp deploy/single-host.env.example /etc/benchone/benchone.env
sudo chmod 0600 /etc/benchone/benchone.env
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 16
sudo chown 10001:10001 /srv/benchone-backups
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
  --env-file /etc/benchone/benchone.env \
  -f deploy/compose.single-host.yml \
  --profile operations config --quiet
npm run test:deployment:compose -- /etc/benchone/benchone.env
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
  --env-file /etc/benchone/benchone.env \
  -f deploy/compose.single-host.yml \
  build web worker r operations

docker compose \
  --env-file /etc/benchone/benchone.env \
  -f deploy/compose.single-host.yml \
  up -d namespace-anchor postgres
```

Production network signup is always closed. Provision the initial owner (and
later accounts) with the operations image. `-T` is required so the CLI receives
non-TTY stdin and refuses an echoed terminal password. The action and target are
recorded in `operator_audit_events`; the password is never accepted in argv or
written to logs.

```bash
read -rsp 'Initial account password: ' BENCHONE_PASSWORD; echo
printf '%s' "$BENCHONE_PASSWORD" | docker compose \
  --env-file /etc/benchone/benchone.env \
  -f deploy/compose.single-host.yml \
  --profile operations run -T --rm operations \
  scripts/account-admin.js create \
  --email owner@example.org \
  --display-name 'Deployment Owner' \
  --password-stdin
unset BENCHONE_PASSWORD

docker compose \
  --env-file /etc/benchone/benchone.env \
  -f deploy/compose.single-host.yml \
  up -d r worker web
```

The owner can then create projects and add other already-provisioned accounts
through Collaborators. To rotate an account password and revoke all of its
sessions, use the same hidden-input pattern with
`scripts/account-admin.js reset-password --email user@example.org --password-stdin`.
Grant/revoke/status operations for `pipeline_registry.publish` use
`scripts/manage-platform-developer.js` in the same operations image; mutations
are recorded in `operator_audit_events`.

For registry images pinned by digest, pull the reviewed images and omit
`build`. The web process initializes the additive Postgres schema during
startup. Production validation runs before storage directories or sockets are
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

## TLS reverse proxy

The proxy must terminate TLS, replace (not append untrusted values to) all
forwarding headers, preserve the Host, and forward only to host loopback. The
proxy also supplies an independent auth limiter, connection bound, and private
health-route policy. For example, put the zones in the Nginx `http` scope and
the shared proxy directives in `/etc/nginx/snippets/benchone-proxy.conf`:

```nginx
# http scope
limit_req_zone $binary_remote_addr zone=benchone_auth:10m rate=5r/m;
limit_conn_zone $binary_remote_addr zone=benchone_clients:10m;

# /etc/nginx/snippets/benchone-proxy.conf
proxy_pass http://127.0.0.1:3000;
proxy_set_header Host $host;
proxy_set_header Forwarded "";
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Port 443;

server {
    listen 443 ssl;
    server_name benchone.example.org;

    # Match this to the reviewed MAX_UPLOAD_BYTES policy.
    client_max_body_size 512m;
    client_body_timeout 60s;
    proxy_read_timeout 130s;
    limit_conn benchone_clients 8;

    # Production signup is operator-only. Drop it again at ingress.
    location = /api/auth/signup { return 404; }

    location = /api/auth/login {
        limit_req zone=benchone_auth burst=5 nodelay;
        include /etc/nginx/snippets/benchone-proxy.conf;
    }

    # Permit only same-host monitoring by default. Add explicit monitoring
    # source addresses if required; do not make readiness a public endpoint.
    location = /livez {
        allow 127.0.0.1;
        allow ::1;
        deny all;
        include /etc/nginx/snippets/benchone-proxy.conf;
    }
    location = /readyz {
        allow 127.0.0.1;
        allow ::1;
        deny all;
        include /etc/nginx/snippets/benchone-proxy.conf;
    }

    location / {
        include /etc/nginx/snippets/benchone-proxy.conf;
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
application writer: stop web, worker, and R first, while leaving Postgres and the
namespace anchor running.

```bash
docker compose \
  --env-file /etc/benchone/benchone.env \
  -f deploy/compose.single-host.yml \
  stop web worker r

docker compose \
  --env-file /etc/benchone/benchone.env \
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
  --env-file /etc/benchone/benchone.env \
  -f deploy/compose.single-host.yml \
  up -d r worker web
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
docker compose -p benchone-restore \
  --env-file /etc/benchone/restore.env \
  -f deploy/compose.single-host.yml \
  up -d namespace-anchor postgres

docker compose -p benchone-restore \
  --env-file /etc/benchone/restore.env \
  -f deploy/compose.single-host.yml \
  --profile operations run --rm restore-operations \
  scripts/restore-runtime.js \
  --backup /app/backups/backup-2026-07-16T120000Z \
  --storage-root /app/storage-volume/data \
  --vault-root /app/vault-volume/vault \
  --confirm-offline I_CONFIRM_WRITES_ARE_STOPPED

docker compose -p benchone-restore \
  --env-file /etc/benchone/restore.env \
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
docker compose -p benchone-restore \
  --env-file /etc/benchone/restore.env \
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
read -rsp 'Replacement password: ' BENCHONE_PASSWORD; echo
printf '%s' "$BENCHONE_PASSWORD" | docker compose -p benchone-restore \
  --env-file /etc/benchone/restore.env \
  -f deploy/compose.single-host.yml \
  --profile operations run -T --rm operations \
  scripts/account-admin.js reset-password \
  --email user@example.org \
  --password-stdin
unset BENCHONE_PASSWORD
```

Reconcile `pipeline_registry.publish` while the application remains stopped.
The operations image contains the reviewed capability CLI; grant/revoke actions
are transactional and append an operator audit event:

```bash
docker compose -p benchone-restore \
  --env-file /etc/benchone/restore.env \
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
docker compose -p benchone-restore \
  --env-file /etc/benchone/restore.env \
  -f deploy/compose.single-host.yml \
  up -d web

# After private reconciliation and the repeated inventory:
docker compose -p benchone-restore \
  --env-file /etc/benchone/restore.env \
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
docker compose -p benchone-restore \
  --env-file /etc/benchone/restore.env \
  -f deploy/compose.single-host.yml \
  config --quiet

npm run test:deployment:compose -- /etc/benchone/restore.env

docker compose -p benchone-restore \
  --env-file /etc/benchone/restore.env \
  -f deploy/compose.single-host.yml \
  up -d --force-recreate r worker web

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
documented constraints are accepted. Multi-host/HA, parallel R execution,
untrusted arbitrary code, and managed hosted infrastructure require separate
architecture work.
