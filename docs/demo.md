# Deploy a student demo

The Azure PBMC3k demo opens directly into a guided Seurat analysis with an isolated,
expiring guest session. Visitors do not register or log in. The Azure deployment
uses the original counts from a verified public 10x PBMC3k checkpoint. Visitors
start with QC distributions for 2,700 input cells, choose quality thresholds,
run normalization and PCA, inspect the elbow plot, and choose clustering and UMAP
parameters. Every stage runs Seurat and saves its result; no UMAP is prepared on
entry. Reapplying QC starts from the original counts and clears downstream results.
Uploads, account login, custom R, collaboration UI, and advanced analyses are
disabled for this focused experience. Private installations keep their full UI.

The default local demo fixture is a small synthetic tutorial and retains the
fixture workbench. The guided experience is enabled for demo deployments with
`DEMO_DATASET=pbmc3k`.
It needs a Linux VM, Docker Compose, HTTPS, and persistent storage. It cannot
run as a static site or fit on a typical 512 MiB free web service.

## Hosting options

Verified September 13, 2026:

| Option | Fit for this project |
| --- | --- |
| [Oracle Always Free Ampere](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) | The documented 2-OCPU/12-GB allowance matches the constrained demo profile. Capacity depends on the home region; idle instances can be reclaimed. |
| [Azure for Students](https://azure.microsoft.com/en-us/free/students) | Eligible students receive $100 credit for use within 12 months without a credit card. Use a Linux VM with at least 12 GB RAM, subject to available sizes and quota. Credit is finite, so estimate VM and disk costs before provisioning. |

The Compose resource settings work on ARM64 or x86-64 when the images are built
for the host architecture. The checked-in image tags contain `arm64` because the
original target was Ampere; use distinct tags if building for another architecture.
The demo profile is sized for the bundled 800-cell tutorial. Uploaded studies and
user-authored code are disabled in the public service.

## Verify locally

With Docker running, install the Node dependencies and Playwright browser, then
run the isolated acceptance check:

```bash
npm ci
npx playwright install --with-deps chromium
npm run test:demo-compose -- --free-tier
```

The check builds the images, creates a synthetic tutorial, and tests guest access,
plots, analysis, persistence across service restarts, and expired-guest cleanup.
It uses temporary configuration and separate Docker volumes, which it removes
afterward. Omit `--free-tier` to test the standard demo profile.

The constrained check applies the production resource limits but uses a local
HTTP endpoint in place of Caddy. It does not verify public HTTPS, ARM image builds,
or performance on the chosen VM. Complete the public browser check below before
sharing the deployment.

## Prepare configuration

On the chosen host, clone the repository and install Node.js 22 and Docker
Engine with the Compose plugin. Point a DNS hostname at the VM. The operator
runbook covers [network and HTTPS setup](deployment.md#free-tier-arm64-deployment-candidate).

Generate the configuration without copying passwords by hand:

```bash
npm run demo:configure -- --host demo.example.org
sudo install -d -m 0750 /etc/traceomics /srv/traceomics-demo-backups
sudo install -m 0600 deploy/demo.env /etc/traceomics/demo.env
sudo chown 10001:10001 /srv/traceomics-demo-backups
```

The command writes independent random session, database, and R-service secrets.
It refuses to overwrite an existing configuration. `.env` files are ignored by
Git, but keep both copies private and back them up separately. Set `--output`
to choose a different destination.

## Build and bootstrap

```bash
COMPOSE='docker compose -p traceomics-demo --env-file /etc/traceomics/demo.env -f deploy/compose.single-host.yml -f deploy/compose.demo.yml -f deploy/compose.demo-free-tier.yml'
$COMPOSE --profile demo-bootstrap config --quiet
npm run test:deployment:compose -- /etc/traceomics/demo.env
$COMPOSE build web r operations
$COMPOSE up -d namespace-anchor postgres storage-init
$COMPOSE --profile demo-bootstrap run --rm demo-template-prepare
$COMPOSE --profile demo-bootstrap run --rm demo-template-r
$COMPOSE --profile demo-bootstrap run --rm demo-template-finalize
```

Building the R image installs the scientific packages and can take a long time.
Copy the project ID printed by the final command into `DEMO_TEMPLATE_PROJECT_ID`
in `/etc/traceomics/demo.env`. Then start the services:

```bash
$COMPOSE --profile demo-ops config --quiet
$COMPOSE up -d --wait --wait-timeout 300 r r-compute-1 r-compute-2 web worker worker-compute-1 worker-compute-2 caddy
curl --fail http://127.0.0.1:3001/readyz
curl --fail https://demo.example.org/api/auth/policy
```

Replace `demo.example.org` with your hostname. The policy must report demo mode,
uploads disabled, and custom R execution disabled. Install the locked Node
dependencies and Chromium, then exercise the real public demo:

```bash
npm ci
npx playwright install --with-deps chromium
PUBLIC_DEMO_ORIGIN=https://demo.example.org npm run test:demo-browser
```

Follow the [operations runbook](deployment.md#free-tier-arm64-deployment-candidate)
to schedule guest cleanup every ten minutes, preserve the tutorial backup, and
monitor disk space and health. Configuration checks alone do not verify a live
deployment: complete the browser run on the target host before sharing its URL.
