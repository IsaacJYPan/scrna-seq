param([switch]$Paper)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $projectRoot
$fixtureRoot = Join-Path $projectRoot 'scratch/local-cluster-test'
New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
function Docker-Checked {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw 'Disposable fixture Docker command failed.' }
}
# Refuse collisions rather than changing an existing running fixture.
foreach ($containerName in @('tro-mcp-pg-test','tro-mcp-cluster-test','tro-mcp-r-test')) {
    $existing = & docker ps -a --filter "name=^/$containerName`$" --format '{{.Names}}'
    if ($existing) { throw "Container $containerName already exists. Inspect or remove your previous disposable fixture first." }
}
if (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'client'))) {
    # Node preserves a truly empty passphrase argument across PowerShell versions.
    & node --input-type=module -e 'import {execFileSync} from "node:child_process"; execFileSync("ssh-keygen",["-q","-t","ed25519","-N","","-f","scratch/local-cluster-test/client"]);'
    if ($LASTEXITCODE -ne 0) { throw 'Fixture key generation failed.' }
}
Docker-Checked build -t traceomics-local-cluster:test scripts/local-cluster-test
Docker-Checked run -d --name tro-mcp-pg-test -p 127.0.0.1:45432:5432 -e POSTGRES_PASSWORD=local-fixture-only -e POSTGRES_DB=tro_mcp_test postgres:16-alpine
Docker-Checked run -d --name tro-mcp-cluster-test --cpus 2 --memory 8g -p 127.0.0.1:43222:2222 --mount "type=bind,source=$fixtureRoot/client.pub,target=/fixture/client.pub,readonly" traceomics-local-cluster:test
$hostKey = & docker exec tro-mcp-cluster-test cat /etc/ssh/ssh_host_ed25519_key.pub
if ($LASTEXITCODE -ne 0) { throw 'Fixture host key inspection failed.' }
Set-Content -LiteralPath (Join-Path $fixtureRoot 'known_hosts') -Value "[127.0.0.1]:43222 $hostKey" -Encoding ascii
Docker-Checked run -d --name tro-mcp-r-test --cpus 2 --memory 6g -p 127.0.0.1:48000:8000 -e PLUMBER_HOST=0.0.0.0 -e API_TOKEN=local-test-r-token-0123456789abcdef -e STORAGE_ROOT=/fixture/storage -e VAULT_ROOT=/fixture/vault -e R_MAX_ACTIVE_SESSION_BYTES=5368709120 -e R_MAX_ACTIVE_SESSION_BYTES_PER_USER=4294967296 -e R_MAX_ACTIVE_SESSION_BYTES_PER_SESSION=3221225472 --mount "type=bind,source=$projectRoot,target=/source,readonly" --mount "type=bind,source=$fixtureRoot,target=/fixture" --entrypoint Rscript traceomics-r:single-host /source/r-backend/run.R
Docker-Checked run --rm --memory 3g --network none --mount "type=bind,source=$projectRoot,target=/source,readonly" --mount "type=bind,source=$fixtureRoot,target=/fixture" --entrypoint Rscript traceomics-r:single-host /source/scripts/local-cluster-test/prepare-input.R
& node scripts/local-cluster-test/run.mjs
if ($LASTEXITCODE -ne 0) { throw 'PBMC3k MCP test failed.' }
& node scripts/local-cluster-test/verify-transport.mjs
if ($LASTEXITCODE -ne 0) { throw 'Transport scenario tests failed.' }
if ($Paper) {
    $paperInput = Join-Path $fixtureRoot 'pbmc68k_data.rds'
    if (-not (Test-Path -LiteralPath $paperInput)) {
        Invoke-WebRequest -Uri 'https://cf.10xgenomics.com/samples/cell/pbmc68k_rds/pbmc68k_data.rds' -OutFile $paperInput
    }
    Docker-Checked run --rm --memory 6g --network none --mount "type=bind,source=$projectRoot,target=/source,readonly" --mount "type=bind,source=$fixtureRoot,target=/fixture" --entrypoint Rscript traceomics-r:single-host /source/scripts/local-cluster-test/prepare-paper.R
    $previousPaperSetting = $env:PAPER_BENCHMARK
    try { $env:PAPER_BENCHMARK = 'true'; & node scripts/local-cluster-test/run.mjs; if ($LASTEXITCODE -ne 0) { throw 'Paper subset MCP test failed.' } }
    finally { $env:PAPER_BENCHMARK = $previousPaperSetting }
    Docker-Checked run --rm --memory 4g --network none --mount "type=bind,source=$projectRoot,target=/source,readonly" --mount "type=bind,source=$projectRoot/exports/paper-reproduction,target=/output" --entrypoint Rscript traceomics-r:single-host /source/scripts/local-cluster-test/compare-paper.R
}
Write-Output 'Reports are in exports/paper-reproduction. Containers remain available for inspection. Remove only the three named disposable fixture containers when finished.'
