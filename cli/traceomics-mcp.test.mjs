import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createMcpServer, serveStdio, TOOLS } from './traceomics-mcp.mjs';

const TOKEN = `tro_agent_${'A'.repeat(43)}`;
const ENV = { TRACEOMICS_AGENT_TOKEN: TOKEN, TRACEOMICS_URL: 'http://127.0.0.1:9' };

function recordingFetch(status = 200, body = { schema: 'x', ok: true }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

describe('traceomics MCP server', () => {
  it('initializes and lists tools without credentials in any schema', async () => {
    const server = createMcpServer({ env: ENV });
    const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'traceomics' }, capabilities: { tools: {} } });
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_context', 'list_studies', 'create_plan', 'submit_run', 'get_run_results']));
    expect(JSON.stringify(list.result.tools)).not.toMatch(/token/i);
    expect(TOOLS.find((t) => t.name === 'submit_run').annotations.readOnlyHint).toBe(false);
    expect((await server.handle({ jsonrpc: '2.0', id: 3, method: 'shell/exec' })).error.code).toBe(-32601);
  });

  it('maps a tool call to one automation request with the bearer credential', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const server = createMcpServer({ env: ENV, fetchImpl });
    const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'create_plan', arguments: { projectId: 'proj_1', studyId: `study_${'a'.repeat(24)}`, datasetId: 'ds_1', choices: { clusterResolution: 0.8 } },
    } });
    expect(reply.result.isError).toBeUndefined();
    expect(JSON.parse(reply.result.content[0].text)).toEqual({ schema: 'x', ok: true });
    expect(calls[0].url).toBe('http://127.0.0.1:9/api/automation/v1/projects/proj_1/plans');
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0].init.body)).toEqual({ studyId: `study_${'a'.repeat(24)}`, datasetId: 'ds_1', choices: { clusterResolution: 0.8 } });
  });

  it('derives a stable request id so a repeated submit replays', async () => {
    const { calls, fetchImpl } = recordingFetch(201);
    const server = createMcpServer({ env: ENV, fetchImpl });
    const args = { projectId: 'proj_1', planId: `plan_${'b'.repeat(24)}`, planDigest: 'c'.repeat(64) };
    await server.callTool('submit_run', args);
    await server.callTool('submit_run', args);
    const [a, b] = calls.map((c) => JSON.parse(c.init.body).requestId);
    expect(a).toBe(b);
  });

  it('rejects bad ids, unknown arguments, and missing credentials before any request', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const server = createMcpServer({ env: ENV, fetchImpl });
    expect((await server.callTool('get_project', { projectId: '../admin' })).result.isError).toBe(true);
    expect((await server.callTool('get_context', { token: 'x' })).result.content[0].text).toMatch(/Unknown argument/);
    expect((await server.callTool('nope', {})).error.code).toBe(-32602);
    const noToken = createMcpServer({ env: { TRACEOMICS_URL: ENV.TRACEOMICS_URL }, fetchImpl });
    expect((await noToken.callTool('get_context', {})).result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('runs an R script in a sandbox with a stable request id and returns figures as images', async () => {
    const { calls, fetchImpl } = recordingFetch(201, { schema: 'x', run: { id: 'sbr_1' } });
    const server = createMcpServer({ env: ENV, fetchImpl });
    const args = { projectId: 'proj_1', sandboxId: `sbx_${'a'.repeat(24)}`, title: 'Markers', script: 'print(1)' };
    await server.callTool('run_r_script', args);
    await server.callTool('run_r_script', args);
    expect(calls[0].url).toBe(`http://127.0.0.1:9/api/automation/v1/projects/proj_1/sandboxes/sbx_${'a'.repeat(24)}/runs`);
    const [a, b] = calls.map((c) => JSON.parse(c.init.body));
    expect(a).toEqual({ title: 'Markers', script: 'print(1)', requestId: expect.any(String) });
    expect(a.requestId).toBe(b.requestId);
    expect(TOOLS.find((t) => t.name === 'run_r_script').annotations.readOnlyHint).toBe(false);

    const image = createMcpServer({ env: ENV, fetchImpl: recordingFetch(200, {
      kind: 'image', mimeType: 'image/png', name: 'umap.png', sizeBytes: 3, base64: 'AAAA' }).fetchImpl });
    const shown = await image.callTool('read_sandbox_file', { projectId: 'proj_1', runId: `sbr_${'b'.repeat(24)}`, file: 'umap.png' });
    expect(shown.result.content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    const text = createMcpServer({ env: ENV, fetchImpl: recordingFetch(200, { kind: 'text', text: 'gene,p\n' }).fetchImpl });
    expect((await text.callTool('read_sandbox_file', { projectId: 'proj_1', runId: `sbr_${'b'.repeat(24)}`, file: 'm.csv' }))
      .result.content).toEqual([{ type: 'text', text: 'gene,p\n' }]);
    expect((await server.callTool('read_sandbox_file', { projectId: 'proj_1', runId: `sbr_${'b'.repeat(24)}`, file: '../x' }))
      .result.isError).toBe(true);
  });

  it('writes report sections with figures', async () => {
    const { calls, fetchImpl } = recordingFetch(201);
    const server = createMcpServer({ env: ENV, fetchImpl });
    await server.callTool('write_report_section', {
      projectId: 'proj_1', reportId: `rep_${'c'.repeat(24)}`, key: 'results', heading: 'Results', body: 'Two clusters.',
      figures: [{ sandboxRunId: `sbr_${'d'.repeat(24)}`, file: 'umap.png', caption: 'UMAP' }],
    });
    expect(calls[0].url).toMatch(/\/reports\/rep_c{24}\/sections$/);
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ key: 'results', figures: [{ file: 'umap.png' }], requestId: expect.any(String) });
  });

  it('reports server refusals as tool errors', async () => {
    const { fetchImpl } = recordingFetch(429, { error: 'Over budget', code: 'BUDGET_EXCEEDED' });
    const out = await createMcpServer({ env: ENV, fetchImpl }).callTool('list_studies', { projectId: 'proj_1' });
    expect(out.result.isError).toBe(true);
    expect(JSON.parse(out.result.content[0].text).code).toBe('BUDGET_EXCEEDED');
  });

  it('speaks newline-delimited JSON-RPC on stdio', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];
    output.on('data', (c) => chunks.push(String(c)));
    const done = serveStdio({ input, output, env: ENV, fetchImpl: recordingFetch().fetchImpl });
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\nnot json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_context' } })}\n`);
    input.end();
    await done;
    const replies = chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(replies).toEqual(expect.arrayContaining([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      expect.objectContaining({ id: 2, result: expect.objectContaining({ content: expect.any(Array) }) }),
    ]));
  });
});
