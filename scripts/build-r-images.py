#!/usr/bin/env python3
"""Publish/reuse digest-pinned R bases and BuildKit registry caches.

docker login <registry> first (for ACR use az acr login; no client secret).
python scripts/build-r-images.py --registry <registry> --profile demo --tag reviewed
Use --base-revision to deliberately refresh scientific dependencies. Application
source changes do not change the scientific base key. This script provisions no
registry, VM, CI workflow, identity, or other cloud resource.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
CONTEXT = ROOT / 'r-backend'


def run(args, **kwargs):
    return subprocess.run(['docker', 'buildx', *args], check=True, **kwargs)


def digest(reference):
    result = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', reference,
                             '--format', '{{json .Manifest}}'], capture_output=True, text=True)
    if result.returncode:
        if any(message in result.stderr.lower() for message in ['not found', 'manifest unknown']):
            return None
        raise RuntimeError(result.stderr)
    value = json.loads(result.stdout)['digest']
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', value):
        raise RuntimeError('Invalid registry manifest digest')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--registry', required=True)
    parser.add_argument('--profile', choices=['private', 'demo'], default='demo')
    parser.add_argument('--dataset', choices=['synthetic', 'pbmc3k'], default='synthetic')
    parser.add_argument('--tag', default='local-review')
    parser.add_argument('--platform', default='linux/amd64')
    parser.add_argument('--base-revision', default='1')
    parser.add_argument('--output', type=Path, default=ROOT / 'scratch/r-images/build.json')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.:-]*(?:/[a-zA-Z0-9_.-]+)*', args.registry):
        parser.error('Registry must be a hostname[:port][/namespace], without credentials or URL scheme')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.dataset == 'pbmc3k' and args.profile != 'demo':
        parser.error('PBMC3k selection is only supported for the demo image')
    records = {'profile': args.profile, 'dataset': args.dataset, 'platform': args.platform, 'bases': []}

    def base(name, filename, target, content, build_args=()):
        key = hashlib.sha256(content + args.platform.encode() + args.base_revision.encode()).hexdigest()[:20]
        reference = f'{args.registry}/{name}:{key}'
        started = time.monotonic()
        known = digest(reference)
        reused = known is not None
        if not known:
            cache = f'{args.registry}/{name}:buildcache-{args.platform.replace("/", "-")}'
            command = ['build', '--platform', args.platform, '--target', target, '-f', str(CONTEXT / filename),
                       '-t', reference, '--push', '--cache-from', 'type=registry,ref=' + cache,
                       '--cache-to', 'type=registry,ref=' + cache + ',mode=max', '--progress', 'plain']
            for value in build_args:
                command += ['--build-arg', value]
            run([*command, str(CONTEXT)])
            known = digest(reference)
        if not known:
            raise RuntimeError('Published base missing from registry')
        pinned = reference.rsplit(':', 1)[0]
        pinned += '@' + known
        records['bases'].append({'image': pinned, 'reused': reused, 'seconds': time.monotonic() - started})
        return pinned

    package_code = (CONTEXT / 'image-packages.R').read_bytes()
    full_source = (CONTEXT / 'Dockerfile').read_text().split('FROM ${R_BASE_IMAGE} AS runtime')[0].encode()
    scientific = base('traceomics-r-base', 'Dockerfile', 'scientific-base',
                      full_source + package_code + (CONTEXT / 'install-r-packages.sh').read_bytes())
    filename = 'Dockerfile'
    runtime_arg = 'R_BASE_IMAGE=' + scientific
    if args.profile == 'demo':
        demo_source = (CONTEXT / 'Dockerfile.demo').read_text().split('FROM ${DEMO_BASE_IMAGE} AS demo-artifact')[0].encode()
        scientific = base('traceomics-r-demo-base', 'Dockerfile.demo', 'demo-dependencies',
                          demo_source + package_code + scientific.encode(), ['SCIENTIFIC_BASE=' + scientific])
        filename = 'Dockerfile.pbmc-demo' if args.dataset == 'pbmc3k' else 'Dockerfile.demo'
        runtime_arg = 'DEMO_BASE_IMAGE=' + scientific
    image = f'{args.registry}/traceomics-r{ "-demo" if args.profile == "demo" else ""}:{args.tag}'
    cache = f'{args.registry}/traceomics-r-{args.profile}:app-cache-{args.platform.replace("/", "-")}'
    started = time.monotonic()
    run(['build', '--platform', args.platform, '--target', 'runtime', '-f', str(CONTEXT / filename),
         '--build-arg', runtime_arg, '-t', image, '--push', '--progress', 'plain',
         '--cache-from', 'type=registry,ref=' + cache,
         '--cache-to', 'type=registry,ref=' + cache + ',mode=max', str(CONTEXT)])
    records.update(image=image.rsplit(':', 1)[0] + '@' + digest(image), applicationBuildSeconds=time.monotonic() - started)
    args.output.write_text(json.dumps(records, indent=2))
    print(json.dumps(records, indent=2))


if __name__ == '__main__':
    main()
