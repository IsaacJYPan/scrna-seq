"""Reference Jupyter client adapter; executed inside an isolated private container.

Only bounded JSON is written to the broker pipe. Kernel connection files and
local ZeroMQ sockets stay inside this container, with no published ports.
"""
import base64
import hashlib
import json
import math
import os
import queue
import re
import select
import stat
import struct
import sys
import time

from jupyter_client import KernelManager
from jupyter_client.kernelspec import KernelSpecManager

SOURCE_BYTES = 32768
STDOUT_BYTES = 65536
DIAGNOSTIC_BYTES = 8192
FIGURE_BYTES = 262144
RESPONSE_BYTES = 1048576
EXPORT_BYTES = 20 * 1024 * 1024


def export_directory():
    root = os.open('/work', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        return os.open('export', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
    finally:
        os.close(root)


def export_evidence(directory, filename):
    handle = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    try:
        entry = os.fstat(handle)
        if not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1 or entry.st_size > EXPORT_BYTES:
            raise ValueError('Invalid isolated output.')
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(handle, 65536)
            if not chunk:
                break
            total += len(chunk)
            if total > EXPORT_BYTES:
                raise ValueError('Isolated output exceeds its limit.')
            digest.update(chunk)
        if total != entry.st_size:
            raise ValueError('Isolated output changed during verification.')
        return {'checksumSha256': digest.hexdigest(), 'sizeBytes': total}
    finally:
        os.close(handle)


def bounded(value, maximum):
    raw = str(value).encode('utf-8')
    return raw[:maximum].decode('utf-8', errors='ignore'), len(raw) > maximum


def emit(value):
    raw = json.dumps(value, allow_nan=False, separators=(',', ':'), ensure_ascii=False)
    if len(raw.encode('utf-8')) > RESPONSE_BYTES:
        raise RuntimeError('Private kernel response exceeds its transport limit.')
    sys.stdout.write(raw + '\n')
    sys.stdout.flush()


def safe_table(value):
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict) or not isinstance(value.get('columns'), list) or not isinstance(value.get('rows'), list):
        raise ValueError('Invalid table output.')
    columns = value['columns'][:30]
    if not columns or any(not isinstance(v, str) or len(v) > 200 for v in columns):
        raise ValueError('Invalid table columns.')
    rows = []
    truncated = bool(value.get('truncated')) or len(value['rows']) > 100 or len(value['columns']) > 30
    for row in value['rows'][:100]:
        if not isinstance(row, list) or len(row) < len(columns):
            raise ValueError('Invalid table row.')
        safe = []
        for cell in row[:len(columns)]:
            if cell is None or isinstance(cell, bool):
                safe.append(cell)
            elif isinstance(cell, (int, float)) and math.isfinite(cell):
                safe.append(cell)
            elif isinstance(cell, str):
                safe.append(cell[:2000]); truncated = truncated or len(cell) > 2000
            else:
                raise ValueError('Invalid table cell.')
        rows.append(safe)
    result = {'columns': columns, 'rows': rows, 'truncated': truncated}
    if isinstance(value.get('name'), str):
        result['name'] = value['name'][:120]
    return result


def safe_figure(encoded):
    if not isinstance(encoded, str) or len(encoded) > (FIGURE_BYTES * 4 // 3 + 8192):
        raise ValueError('Figure exceeds its size limit.')
    # IRdisplay emits folded base64 lines. Remove only ASCII line whitespace,
    # then validate strictly and return one canonical encoded string.
    encoded = encoded.translate(str.maketrans('', '', ' \t\r\n'))
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) > FIGURE_BYTES or len(raw) < 24 or raw[:8] != b'\x89PNG\r\n\x1a\n' or raw[12:16] != b'IHDR':
        raise ValueError('Invalid PNG output.')
    width, height = struct.unpack('>II', raw[16:24])
    if width < 1 or height < 1 or width > 8192 or height > 8192 or width * height > 12000000:
        raise ValueError('Figure dimensions exceed the limit.')
    return {'mimeType': 'image/png', 'data': base64.b64encode(raw).decode('ascii'), 'width': width, 'height': height,
            'sha256': hashlib.sha256(raw).hexdigest()}


def execute(client, source, timeout, is_alive=lambda: True):
    request_id = client.execute(source, silent=False, store_history=True, allow_stdin=False, stop_on_error=True)
    deadline = time.monotonic() + timeout
    result = {'status': 'completed', 'stdout': '', 'warnings': [], 'error': None, 'tables': [], 'figures': [], 'truncated': False}
    idle = False
    reply = None
    warning_bytes = 0
    while not idle or reply is None:
        if not is_alive():
            raise RuntimeError('The private R kernel process has stopped.')
        if time.monotonic() >= deadline:
            raise TimeoutError('Private kernel execution exceeded its time limit.')
        try:
            message = client.get_iopub_msg(timeout=0.05)
        except queue.Empty:
            message = None
        if message and message.get('parent_header', {}).get('msg_id') == request_id:
            kind = message['header']['msg_type']
            content = message['content']
            if kind == 'status' and content.get('execution_state') == 'idle':
                idle = True
            elif kind == 'stream':
                text = content.get('text', '')
                if content.get('name') == 'stderr':
                    text, clipped = bounded(text, max(0, DIAGNOSTIC_BYTES - warning_bytes))
                    if text:
                        # One warning string prevents an unbounded message count.
                        existing = ''.join(result['warnings']) + text
                        while len(json.dumps([existing], ensure_ascii=False).encode('utf-8')) > DIAGNOSTIC_BYTES:
                            existing = existing[:-1]; clipped = True
                        result['warnings'] = [existing] if existing else []
                        warning_bytes = len(existing.encode('utf-8'))
                    result['truncated'] = result['truncated'] or clipped
                else:
                    result['stdout'], clipped = bounded(result['stdout'] + str(text), STDOUT_BYTES)
                    result['truncated'] = result['truncated'] or clipped
            elif kind == 'error':
                text, clipped = bounded(content.get('evalue', 'R execution failed.'), DIAGNOSTIC_BYTES)
                result['error'] = {'message': text, 'code': 'R_ERROR'}
                result['status'] = 'failed'; result['truncated'] = result['truncated'] or clipped
            elif kind in ('execute_result', 'display_data'):
                data = content.get('data', {})
                if 'application/vnd.traceomics.table+json' in data:
                    if len(result['tables']) < 2:
                        try:
                            result['tables'].append(safe_table(data['application/vnd.traceomics.table+json']))
                        except (ValueError, TypeError, json.JSONDecodeError):
                            result['truncated'] = True
                    else:
                        result['truncated'] = True
                elif 'image/png' in data:
                    if len(result['figures']) < 4:
                        try:
                            result['figures'].append(safe_figure(data['image/png']))
                        except (ValueError, TypeError):
                            result['truncated'] = True
                    else:
                        result['truncated'] = True
                elif 'text/plain' in data:
                    result['stdout'], clipped = bounded(result['stdout'] + str(data['text/plain']) + '\n', STDOUT_BYTES)
                    result['truncated'] = result['truncated'] or clipped
                # HTML/JavaScript/SVG/widgets and other active rich MIME are not transported.
        try:
            shell = client.get_shell_msg(timeout=0)
            if shell.get('parent_header', {}).get('msg_id') == request_id:
                reply = shell['content']
        except queue.Empty:
            pass
    if reply.get('status') != 'ok' and result['error'] is None:
        text, clipped = bounded(reply.get('evalue', 'R execution did not complete.'), DIAGNOSTIC_BYTES)
        result['error'] = {'message': text, 'code': 'R_ERROR'}
        result['status'] = 'failed'; result['truncated'] = result['truncated'] or clipped
    # Large tables plus multiple figures can individually fit their limits while
    # exceeding the overall budget. Drop rich items visibly, retaining diagnostics.
    while len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > RESPONSE_BYTES - 2048:
        if result['figures']:
            result['figures'].pop()
        elif result['tables']:
            result['tables'].pop()
        else:
            raise RuntimeError('Private kernel output exceeds its limit.')
        result['truncated'] = True
    return result


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--probe':
        spec = KernelSpecManager().get_kernel_spec('ir')
        if not spec.argv or 'IRkernel::main' not in ' '.join(spec.argv):
            raise RuntimeError('The installed R kernelspec is incompatible.')
        emit({'ok': True, 'protocol': 'jupyter', 'adapter': 1, 'publications': True})
        return
    os.umask(0o077)
    os.mkdir('/work/export', mode=0o700)
    manager = KernelManager(kernel_name='ir', connection_file='/tmp/private-r-connection.json')
    manager.autorestart = False
    sink = open(os.devnull, 'w')
    try:
        manager.start_kernel(cwd='/work', stdout=sink, stderr=sink)
        client = manager.blocking_client()
        client.start_channels()
        client.wait_for_ready(timeout=60)
        initialized = execute(client, "source('/app/private-kernel-init.R', local=.GlobalEnv)", 90, manager.is_alive)
        if initialized['status'] != 'completed':
            raise RuntimeError('Selected kernel inputs could not be loaded.')
        emit({'ok': True, 'event': 'ready', 'protocol': 'jupyter', 'adapter': 1})
        while True:
            readable, _, _ = select.select([sys.stdin], [], [], 1)
            if not manager.is_alive():
                raise RuntimeError('The private R kernel process has stopped.')
            if not readable:
                continue
            raw = sys.stdin.buffer.readline(SOURCE_BYTES * 6 + 4096)
            if not raw:
                break
            if not raw.endswith(b'\n'):
                raise ValueError('Kernel request exceeds its limit.')
            request = json.loads(raw)
            if request.get('action') == 'stop':
                emit({'ok': True, 'event': 'stopped'})
                break
            if request.get('action') != 'execute' or not isinstance(request.get('source'), str) or len(request['source'].encode('utf-8')) > SOURCE_BYTES:
                raise ValueError('Invalid private kernel request.')
            publication = request.get('publication')
            directory = None
            try:
                if publication is not None:
                    if not isinstance(publication, dict) or not re.fullmatch(r'[0-9a-f]{64}\.(rds|csv)', publication.get('filename', '')):
                        raise ValueError('Invalid publication.')
                    directory = export_directory()
                    try:
                        os.stat(publication['filename'], dir_fd=directory, follow_symlinks=False)
                    except FileNotFoundError:
                        pass
                    else:
                        raise ValueError('Publication output already exists.')
                result = execute(client, request['source'], min(600, max(1, int(request.get('timeoutSeconds', 300)))), manager.is_alive)
                if publication is not None and result['status'] == 'completed':
                    result['exportFile'] = export_evidence(directory, publication['filename'])
            finally:
                if directory is not None:
                    os.close(directory)
            emit({'ok': True, 'event': 'execution', 'executionId': request['executionId'], **result})
    finally:
        if manager.has_kernel:
            manager.shutdown_kernel(now=True)
        sink.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # The broker reports loss of unsaved state. Host details or connection
        # keys from reference-client exceptions must never enter the public pipe.
        emit({'ok': False, 'event': 'fatal', 'code': 'PRIVATE_KERNEL_TRANSPORT_FAILED'})
        sys.exit(1)
