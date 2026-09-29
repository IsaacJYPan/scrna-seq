#!/usr/bin/env python3
"""Compare fresh, offline R containers using cached images (not VM/pull latency)."""
import argparse
import json
from pathlib import Path
import statistics
import subprocess
import time
import uuid


def docker(*args, **kwargs):
    return subprocess.run(['docker', *args], check=True, capture_output=True, text=True, **kwargs).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('images', nargs='+')
    parser.add_argument('--trials', type=int, default=10)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--fixture', type=Path, help='Directory containing checkpoint.rds, mounted read-only')
    args = parser.parse_args()
    if args.trials < 1:
        parser.error('--trials must be positive')
    probe = r'''
      started <- as.numeric(Sys.time())
      deadline <- started + 120
      repeat {
        connection <- try(suppressWarnings(socketConnection("127.0.0.1", port=8000, open="r+", timeout=0.1)), silent=TRUE)
        if (!inherits(connection, "try-error")) { close(connection); break }
        if (as.numeric(Sys.time()) > deadline) stop("R never listened")
        Sys.sleep(0.025)
      }
      listening <- as.numeric(Sys.time())
      headers <- c("X-API-Token"=Sys.getenv("API_TOKEN"))
      con <- url("http://127.0.0.1:8000/health", "rb", headers=headers)
      health <- jsonlite::fromJSON(con); close(con)
      stopifnot(identical(health$status, "ok"))
      healthy <- as.numeric(Sys.time())
      operation <- NULL
      if (file.exists("/fixture/checkpoint.rds")) {
        # Hydrate only the benchmark's isolated session using the same verified
        # internal checkpoint endpoint as the worker; never fabricate a result.
        dir.create("/tmp/bench-storage/projects/proj_bench/checkpoints/job_bench", recursive=TRUE)
        file.copy("/fixture/checkpoint.rds", "/tmp/bench-storage/projects/proj_bench/checkpoints/job_bench/checkpoint.rds")
        reply <- httr::POST("http://127.0.0.1:8000/object/checkpoint-load",
          httr::add_headers("X-API-Token"=Sys.getenv("API_TOKEN"), "X-Object-ID"="user-1:obj-bench"),
          body=list(operation="r.checkpoint.hydrate.v1", storage_key="projects/proj_bench/checkpoints/job_bench/checkpoint.rds",
                    expected_checksum_sha256=digest::digest(file="/fixture/checkpoint.rds", algo="sha256"),
                    expected_size_bytes=file.info("/fixture/checkpoint.rds")$size), encode="json")
        httr::stop_for_status(reply)
        qc <- httr::GET("http://127.0.0.1:8000/qc-distributions", httr::add_headers("X-API-Token"=Sys.getenv("API_TOKEN"), "X-Object-ID"="user-1:obj-bench"))
        httr::stop_for_status(qc)
        stopifnot(httr::content(qc)$n_cells == 800)
        operation <- as.numeric(Sys.time())
      }
      cat(jsonlite::toJSON(list(probeStarted=started, listening=listening, healthy=healthy,
          operation=operation, packages=health$packages), auto_unbox=TRUE), "\n")
    '''
    result = {'scope': 'fresh process/container, images locally cached, network disabled; host page cache not flushed', 'images': {}}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for image in args.images:
        info = json.loads(docker('image', 'inspect', image))[0]
        # With containerd, inspect.Size and `image ls` disk usage differ. Keep
        # Docker's metric named explicitly rather than claiming unpacked size.
        item = {'id': info['Id'], 'dockerReportedImageBytes': info['Size'], 'trials': []}
        result['images'][image] = item
        for number in range(args.trials):
            name = 'traceomics-r-bench-' + uuid.uuid4().hex[:12]
            cmd = ['create', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                   '--security-opt', 'no-new-privileges', '--memory', '4g', '--cpus', '2',
                   '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777,size=512m',
                   '-e', 'API_TOKEN=' + 'a' * 64, '-e', 'STORAGE_ROOT=/tmp/bench-storage', '-e', 'VAULT_ROOT=/tmp/vault']
            if args.fixture:
                cmd += ['--mount', f'type=bind,src={args.fixture.resolve()},dst=/fixture,readonly']
            docker(*cmd, image)
            trial = {'trial': number + 1}
            try:
                started = time.time()
                docker('start', name)
                output = docker('exec', name, 'Rscript', '-e', probe, timeout=160)
                observed = json.loads(output.strip().splitlines()[-1])
                trial.update(startToListenSeconds=observed['listening'] - started,
                             startToHealthSeconds=observed['healthy'] - started,
                             firstHealthSeconds=observed['healthy'] - observed['listening'],
                             healthToSyntheticSeconds=(observed['operation'] - observed['healthy']) if observed.get('operation') else None)
                trial['packageCapabilities'] = observed['packages']
                trial['cgroupPeakBytes'] = int(docker('exec', name, 'cat', '/sys/fs/cgroup/memory.peak').strip())
                trial['passed'] = True
            except Exception as error:
                trial.update(passed=False, error=str(error), logs=docker('logs', name)[-3000:])
            finally:
                docker('rm', '-f', name)
            item['trials'].append(trial)
            args.output.write_text(json.dumps(result, indent=2))
            print(image, number + 1, {k: v for k, v in trial.items() if k not in ['packageCapabilities', 'logs']}, flush=True)
        item['summary'] = {}
        for metric in ['startToListenSeconds', 'startToHealthSeconds', 'firstHealthSeconds', 'healthToSyntheticSeconds', 'cgroupPeakBytes']:
            values = [t[metric] for t in item['trials'] if t.get('passed') and t.get(metric) is not None]
            if values:
                item['summary'][metric] = dict(min=min(values), median=statistics.median(values), max=max(values),
                    p90=statistics.quantiles(values, n=100, method='inclusive')[89] if len(values) >= 10 else None,
                    p95=statistics.quantiles(values, n=100, method='inclusive')[94] if len(values) >= 20 else None)
        item['failures'] = sum(not t['passed'] for t in item['trials'])
        args.output.write_text(json.dumps(result, indent=2))
    if any(item['failures'] for item in result['images'].values()):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
