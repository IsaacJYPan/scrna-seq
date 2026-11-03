import { describe, it, expect } from 'vitest';
import { parseArgs, buildRequest, run, EXIT, defaultRequestId } from './traceomics.mjs';

const TOKEN = `tro_agent_${'A'.repeat(43)}`;

function sink() {
  const chunks = [];
  return { write: (c) => { chunks.push(String(c)); return true; }, text: () => chunks.join('') };
}

describe('traceomics CLI', () => {
  it('refuses credentials on the command line', () => {
    expect(() => parseArgs(['context', '--token', TOKEN])).toThrow(/TRACEOMICS_AGENT_TOKEN/);
  });

  it('derives a stable request id so a re-run replays instead of duplicating', () => {
    const args = ['proposals', 'create', '--project', 'proj_1', '--kind', 'code', '--title', 'T', '--patch', 'p.diff'];
    const a = buildRequest(parseArgs(args), { readFile: () => 'diff' });
    const b = buildRequest(parseArgs(args), { readFile: () => 'diff' });
    expect(a.body.requestId).toBe(b.body.requestId);
    expect(a.body.requestId).toMatch(/^cli-[0-9a-f]{40}$/);
    const c = buildRequest(parseArgs(args), { readFile: () => 'other' });
    expect(c.body.requestId).not.toBe(a.body.requestId);
    expect(defaultRequestId(['x'])).toBe(defaultRequestId(['x']));
  });

  it('builds only automation API requests', () => {
    expect(buildRequest(parseArgs(['datasets', 'list', '--project', 'proj_1', '--limit', '5'])))
      .toEqual({ method: 'GET', path: '/projects/proj_1/datasets?limit=5' });
    expect(() => buildRequest(parseArgs(['datasets', 'list', '--project', '../x']))).toThrow(/valid project/);
    expect(() => buildRequest(parseArgs(['shell', 'exec']))).toThrow(/Unknown command/);
  });

  it('sends the credential as a bearer header, prints JSON, and maps exit codes', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ error: 'nope', code: 'SCOPE_DENIED' }), { status: 403 });
    };
    const stdout = sink(); const stderr = sink();
    const code = await run(['datasets', 'list', '--project', 'proj_1'], {
      env: { TRACEOMICS_AGENT_TOKEN: TOKEN, TRACEOMICS_URL: 'http://127.0.0.1:9' }, stdout, stderr, fetchImpl,
    });
    expect(code).toBe(EXIT.DENIED);
    expect(calls[0].url).toBe('http://127.0.0.1:9/api/automation/v1/projects/proj_1/datasets');
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(stdout.text()).code).toBe('SCOPE_DENIED');
    expect(stdout.text() + stderr.text()).not.toContain(TOKEN);
  });

  it('refuses plain HTTP to remote hosts and reports unknown outcomes on network failure', async () => {
    const stderr = sink();
    expect(await run(['context'], { env: { TRACEOMICS_AGENT_TOKEN: TOKEN, TRACEOMICS_URL: 'http://lab.example.org' },
      stdout: sink(), stderr, fetchImpl: async () => { throw new Error('unreachable'); } })).toBe(EXIT.USAGE);
    expect(stderr.text()).toMatch(/plain HTTP/);
    const err2 = sink();
    expect(await run(['context'], { env: { TRACEOMICS_AGENT_TOKEN: TOKEN }, stdout: sink(), stderr: err2,
      fetchImpl: async () => { throw new Error('reset'); } })).toBe(EXIT.UNAVAILABLE);
    expect(err2.text()).toMatch(/outcome is unknown/);
  });
});
