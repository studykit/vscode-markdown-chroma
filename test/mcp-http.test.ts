import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { IndexService, type IndexQuery } from '../src/index/query';
import { startHttp } from '../src/mcp/http';
import { mcpTools } from '../src/mcp/server';
import { presentResult } from '../src/index/presentation';
import { assertRetrievalResult } from './retrieval-contract';

const source = '# Setup\nParent.\n\n## Child\nChild body.\n\n:::{glossary}\nAST\n: Tree definition.\n:::\n';
const options = { host: '127.0.0.1', port: 0, allowedHosts: ['localhost', '127.0.0.1'], allowedOrigins: ['localhost', '127.0.0.1'] };
async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'chroma-http-'));
  const root = path.join(directory, 'notes'), cache = path.join(directory, 'cache');
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'guide.md'), source);
  return { directory, root, cache, service: new IndexService(root, cache), cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}
const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

test('HTTP URL discovers the same tools and reads fresh root-bound content across clients', { timeout: 15000 }, async () => {
  const f = await fixture(), errors: unknown[] = [];
  const handle = await startHttp(f.service, options, error => errors.push(error));
  const clients = [new Client({ name: 'http-one', version: '1' }), new Client({ name: 'http-two', version: '1' })];
  try {
    await Promise.all(clients.map(client => client.connect(new StreamableHTTPClientTransport(new URL(handle.url)))));
    const tools = await clients[0].listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), mcpTools.map(([name]) => name).sort());
    const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })).structuredContent as any;
      assertRetrievalResult(result); return result;
    };
    const sections = await call(clients[0], 'list_sections', { file: 'guide.md' });
    const selected = sections.sections.find((s: any) => s.title === 'Setup');
    assert.deepEqual(sections, { complete: true, file: 'guide.md', sections: [{ title: 'Setup', children: [{ title: 'Child' }] }] });
    const original = await f.service.execute({ command: 'sections', arguments: { file: 'guide.md' } });
    assert.ok('sourceHash' in original);
    const read = await call(clients[1], 'read_section', { file: 'guide.md', title: selected.title });
    assert.match(read.content, /Child body/);
    const term = (await call(clients[0], 'list_terms')).terms[0];
    const queries: [string, IndexQuery][] = [
      ['list_notes', { command: 'notes', arguments: {} }],
      ['list_glossaries', { command: 'glossaries', arguments: {} }],
      ['read_glossaries', { command: 'read-glossary', arguments: { file: 'guide.md', title: 'Child' } }],
      ['read_glossaries', { command: 'read-glossary', arguments: { file: 'guide.md', headingPath: ['Setup', 'Child'] } }],
      ['read_terms', { command: 'read-term', arguments: { ids: [term.id] } }],
      ['read_items', { command: 'read', arguments: { ids: [term.id, 'missing'] } }],
    ];
    for (const [name, query] of queries) assert.deepEqual(await call(clients[0], name, query.arguments), presentResult(await f.service.execute(query)));
    const escaped = await call(clients[0], 'list_sections', { file: '../outside.md' });
    assert.equal(escaped.error.code, 'outsideRoot');
    const changedRoot = await clients[0].callTool({ name: 'list_notes', arguments: { root: f.directory } });
    assert.equal(changedRoot.isError, true);
    await fs.writeFile(path.join(f.root, 'guide.md'), source.replace('Parent.', 'Updated.'));
    const stale = await call(clients[0], 'read_section', { file: 'guide.md', title: selected.title, sourceHash: original.sourceHash });
    assert.equal(stale.error.code, 'documentChanged');
    const current = await call(clients[1], 'read_section', { file: 'guide.md', title: selected.title });
    assert.match(current.content, /Updated/);
    const concurrent = await Promise.all(clients.flatMap(client => Array.from({ length: 3 }, () => call(client, 'list_notes'))));
    assert.ok(concurrent.every(result => result.complete && result.notes[0].file === 'guide.md' && !('root' in result)));
    assert.deepEqual(errors, []);
  } finally { await Promise.all(clients.map(client => client.close())); await handle.close(); await f.cleanup(); }
});

test('HTTP validates Host, Origin, bearer token, endpoint, methods and request size', { timeout: 15000 }, async () => {
  const f = await fixture();
  const handle = await startHttp(f.service, { ...options, token: 'test-only-http-token' }, () => {});
  try {
    assert.equal((await fetch(handle.url)).status, 401);
    assert.equal((await fetch(handle.url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const authorized = { Authorization: 'Bearer test-only-http-token' };
    // Node fetch may overwrite Host; use the raw HTTP API to exercise rebinding protection.
    const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(handle.url, { headers: { ...authorized, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(rejectedHost, 403);
    assert.equal((await fetch(handle.url, { headers: { ...authorized, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(handle.url, { headers: { ...authorized, Origin: 'null' } })).status, 403);
    assert.equal((await fetch(handle.url.replace('/mcp', '/notes'), { headers: authorized })).status, 404);
    assert.equal((await fetch(handle.url, { method: 'PUT', headers: authorized })).status, 405);
    const malformed = await fetch(handle.url, { method: 'POST', headers: { ...headers, ...authorized }, body: '{' });
    assert.equal(malformed.status, 400);
    const large = await fetch(handle.url, { method: 'POST', headers: { ...headers, ...authorized }, body: ' '.repeat(2 * 1024 * 1024 + 1) });
    assert.equal(large.status, 413);
    const client = new Client({ name: 'authorized', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: authorized } }));
      assert.equal((await client.listTools()).tools.length, 13);
    } finally { await client.close(); }
  } finally { await handle.close(); await f.cleanup(); }
});

test('HTTP supports legacy initialize and stateless 2025 tool calls', async () => {
  const f = await fixture(), handle = await startHttp(f.service, options, () => {});
  const post = async (body: unknown) => {
    const response = await fetch(handle.url, { method: 'POST', headers: { ...headers, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify(body) });
    const text = await response.text();
    const data = text.split('\n').find(line => line.startsWith('data: '));
    return { response, json: data ? JSON.parse(data.slice(6)) : text ? JSON.parse(text) : undefined };
  };
  try {
    const initialized = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } });
    assert.equal(initialized.json.result.serverInfo.name, 'markdown-chroma');
    assert.equal(initialized.response.headers.get('mcp-session-id'), null);
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).response.status, 202);
    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_terms', arguments: {} } });
    assert.equal(listed.json.result.structuredContent.terms[0].name, 'AST');
    for (const method of ['GET', 'DELETE']) assert.equal((await fetch(handle.url, { method, headers: { 'mcp-protocol-version': '2025-06-18' } })).status, 405);
  } finally { await handle.close(); await f.cleanup(); }
});

test('HTTP CLI defaults root to cwd, reports URL on stderr and shuts down on SIGTERM', { timeout: 15000 }, async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [path.resolve('dist/cli.cjs'), 'mcp', '--transport', 'http', '--port', '0', '--cache-dir', f.cache], { cwd: f.root });
  const closed = once(child, 'close'); let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`HTTP startup timed out: ${stderr}`)), 8000);
      child.stderr.on('data', data => { stderr += data; const match = /listening at (http:\/\/[^\s]+)/.exec(stderr); if (match) { clearTimeout(timeout); resolve(match[1]); } });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(stderr)); });
    });
    const client = new Client({ name: 'cli-http', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const result = await client.callTool({ name: 'index_documents', arguments: {} });
      assert.deepEqual(result.structuredContent, { complete: true, documents: 1 });
      // Verify background indexing before another query can refresh the snapshot.
      await fs.writeFile(path.join(f.root, 'guide.md'), source.replace('# Setup', '# HTTP watched'));
      const deadline = Date.now() + 4000;
      while (JSON.parse(await fs.readFile(f.service.cacheFile, 'utf8')).documents[0].sections[0].title !== 'HTTP watched') {
        assert.ok(Date.now() < deadline, 'HTTP background watcher did not update the cache'); await delay(20);
      }
    } finally { await client.close(); }
    child.kill('SIGTERM'); assert.equal((await closed)[0], 0);
    assert.equal(stdout, ''); assert.match(stderr, /Root:/);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await f.cleanup(); }
});

test('HTTP launch rejects invalid options, roots and unprotected external access', async () => {
  const execute = promisify(execFile), env = { ...process.env }; delete env.MARKDOWN_CHROMA_MCP_TOKEN;
  for (const args of [
    ['--transport', 'sse'], ['--port', '3000'], ['--transport', 'http', '--port', '-1'],
    ['--transport', 'http', '--port', '65536'], ['--transport', 'http', '--port', '1.5'],
    ['--transport', 'http', '--host', '0.0.0.0'], ['--transport', 'http', '--allowed-hosts', 'evil.example'],
    ['--transport', 'http', '--allowed-origins', 'https://example.com'],
    ['--transport', 'http', '--root', '/nonexistent/chroma-http-root'],
  ]) await assert.rejects(execute(process.execPath, [path.resolve('dist/mcp.cjs'), ...args], { env }), (error: any) => error.stdout === '' && /invalidArguments|invalidRoot/.test(error.stderr));
});

test('HTTP cancellation releases serialized cache-lock waits and occupied ports fail cleanly', { timeout: 15000 }, async () => {
  const f = await fixture(), handle = await startHttp(f.service, options, () => {});
  const client = new Client({ name: 'http-cancellation', version: '1' });
  try {
    await assert.rejects(startHttp(f.service, { ...options, port: Number(new URL(handle.url).port) }, () => {}), { code: 'EADDRINUSE' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    await client.callTool({ name: 'list_notes', arguments: {} });
    const lock = path.join(path.dirname(f.service.cacheFile), 'lock'); await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, owner: 'test' }));
    try {
      await assert.rejects(client.callTool({ name: 'list_notes', arguments: {} }, { signal: AbortSignal.timeout(100) }));
    } finally { await fs.rm(lock, { recursive: true }); }
    const result = await client.callTool({ name: 'list_notes', arguments: {} }, { signal: AbortSignal.timeout(2000) });
    assert.equal((result.structuredContent as any).complete, true);
  } finally { await client.close(); await handle.close(); await f.cleanup(); }
});
