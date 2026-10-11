import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { IndexService, type IndexQuery } from '../src/index/query';
import { MarkdownIndex } from '../src/index/project';
import { runCli } from '../src/index/cli';
import { mcpTools } from '../src/mcp/server';
import { presentResult } from '../src/index/presentation';
import { assertRetrievalResult } from './retrieval-contract';

const source = '---\nstatus: draft\ntags: [project/sub]\n---\n(setup)=\n# Setup\nParent.\n## Child\nChild body.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n![Alt](picture.png)\n\n:::{glossary}\nAST\n: Tree definition.\n\nRole\n: Inline syntax.\n:::\n';
async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'chroma-mcp-'));
  const root = path.join(directory, 'vault'), cache = path.join(directory, 'cache');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'guide.md'), source);
  await fs.writeFile(path.join(root, 'other.md'), '# Other\n[[guide#Setup]] {term}`AST`\n\n:::{glossary}\nAST\n: Another definition.\n:::\n');
  return { root, cache, directory, service: new IndexService(root, cache), cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}
const execute = promisify(execFile);

test('shared queries preserve CLI results, validate selectors and recover after cancellation', async () => {
  const f = await fixture();
  try {
    const queries: [IndexQuery, string[]][] = [
      [{ command: 'search', arguments: { tags: ['project'], where: { status: 'draft' } } }, ['search', '--tag', 'project', '--where', '{"status":"draft"}']],
      [{ command: 'read-frontmatter', arguments: { file: 'guide.md' } }, ['read-frontmatter', 'guide.md']],
      [{ command: 'read-section', arguments: { file: 'guide.md', label: 'setup', includeChildren: false } }, ['read-section', 'guide.md', '--label', 'setup', '--no-children']],
      [{ command: 'read-section', arguments: { file: 'guide.md', title: 'Setup', includeChildren: false } }, ['read-section', 'guide.md', '--title', 'Setup', '--no-children']],
      [{ command: 'read-section', arguments: { file: 'guide.md', headingPath: ['Setup', 'Child'] } }, ['read-section', 'guide.md', '--heading-path', '["Setup","Child"]']],
      [{ command: 'read-term', arguments: { names: ['AST', 'Role', 'missing'] } }, ['read-term', 'AST', 'Role', 'missing']],
      [{ command: 'read', arguments: { selections: [{ kind: 'section', file: 'guide.md', title: 'Setup' }, { kind: 'term', file: 'guide.md', name: 'Role' }] } },
        ['read', '--select', '[{"kind":"section","file":"guide.md","title":"Setup"},{"kind":"term","file":"guide.md","name":"Role"}]']],
    ];
    for (const [query, args] of queries) {
      let stdout = '';
      await runCli([...args, '--root', f.root, '--cache-dir', f.cache, '--debug'], { stdout: value => { stdout += value; }, stderr: () => {} });
      assert.deepEqual(await f.service.execute(query), JSON.parse(stdout));
    }
    await assert.rejects(f.service.execute({ command: 'read-section', arguments: { file: 'guide.md', id: 'setup', label: 'setup' } }), { code: 'invalidArguments' });
    await assert.rejects(f.service.execute({ command: 'read-section', arguments: { file: 'guide.md', title: 'Setup', id: 'setup' } }), { code: 'invalidArguments' });
    await assert.rejects(f.service.execute({ command: 'tables', arguments: { section: 'setup' } }), { code: 'invalidArguments' });
    await assert.rejects(f.service.execute({ command: 'notes', arguments: {} }, { signal: AbortSignal.abort() }));
    const index = new MarkdownIndex(f.root, f.cache);
    const lock = path.join(path.dirname(index.cacheFile), 'lock');
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, owner: 'test' }));
    try { await assert.rejects(f.service.execute({ command: 'notes', arguments: {} }, { signal: AbortSignal.timeout(30) }), { name: 'AbortError' }); }
    finally { await fs.rm(lock, { recursive: true }); }
    const results = await Promise.all(Array.from({ length: 4 }, () => f.service.execute({ command: 'notes', arguments: {} })));
    assert.ok(results.every(result => result.complete));
  } finally { await f.cleanup(); }
});

test('stdio MCP discovers and executes all 15 tools with API parity, partial reads and fresh snapshots', { timeout: 20000 }, async () => {
  const f = await fixture();
  const client = new Client({ name: 'chroma-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp.cjs'), '--root', f.root, '--cache-dir', f.cache], stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), mcpTools.map(([name]) => name).sort());
    assert.ok(!tools.some(tool => tool.name === 'match_text'));
    assert.ok(tools.every(tool => tool.annotations?.readOnlyHint && tool.inputSchema.additionalProperties === false));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = result.content[0]; assert.equal(text.type, 'text');
      if (text.type === 'text' && result.structuredContent) assert.deepEqual(JSON.parse(text.text), result.structuredContent);
      if (result.structuredContent) assertRetrievalResult(result.structuredContent);
      return { ...result, data: result.structuredContent as any };
    };
    const indexed = await call('index_documents', { rebuild: true });
    assert.deepEqual(indexed.data, { complete: true, documents: 2 });
    const sections = await call('list_sections', { file: 'guide.md' });
    assert.deepEqual(sections.data, { complete: true, file: 'guide.md', sections: [{ title: 'Setup', children: [{ title: 'Child' }] }] });
    const terms = await call('list_terms');
    const glossaries = await call('list_glossaries');
    const role = terms.data.terms.find((t: any) => t.name === 'Role');
    const glossary = glossaries.data.glossaries.find((g: any) => g.file === 'guide.md');
    const queries: [string, IndexQuery][] = [
      ['list_notes', { command: 'notes', arguments: {} }],
      ['search_notes', { command: 'search', arguments: { tags: ['project'], where: { status: 'draft' } } }],
      ['read_lines', { command: 'read-lines', arguments: { file: 'guide.md', startLine: 1, endLine: 3 } }],
      ['read_section', { command: 'read-section', arguments: { file: 'guide.md', line: 8 } }],
      ['read_frontmatter', { command: 'read-frontmatter', arguments: { file: 'guide.md' } }],
      ['get_backlinks', { command: 'backlinks', arguments: { file: 'guide.md' } }],
      ['read_section', { command: 'read-section', arguments: { file: 'guide.md', label: 'setup', includeChildren: false } }],
      ['read_section', { command: 'read-section', arguments: { file: 'guide.md', title: 'Setup', includeChildren: false } }],
      ['read_section', { command: 'read-section', arguments: { file: 'guide.md', headingPath: ['Setup', 'Child'] } }],
      ['list_tables', { command: 'tables', arguments: { file: 'guide.md', section: 'child' } }],
      ['list_images', { command: 'images', arguments: {} }],
      ['read_terms', { command: 'read-term', arguments: { names: ['AST', 'Role', 'missing'] } }],
      ['read_glossaries', { command: 'read-glossary', arguments: { ids: [glossary.id] } }],
      ['read_glossaries', { command: 'read-glossary', arguments: { file: 'guide.md', title: 'Child' } }],
      ['read_glossaries', { command: 'read-glossary', arguments: { file: 'guide.md', headingPath: ['Setup', 'Child'] } }],
      ['read_items', { command: 'read', arguments: { ids: [role.id, glossary.id, role.id, 'missing'] } }],
      ['read_items', { command: 'read', arguments: { selections: [
        { kind: 'section', file: 'guide.md', headingPath: ['Setup', 'Child'] },
        { kind: 'term', file: 'guide.md', name: 'AST' },
        { kind: 'section', file: 'guide.md', title: 'Setup' },
      ] } }],
      ['read_items', { command: 'read', arguments: { selections: [
        { kind: 'term', name: 'AST' }, { kind: 'section', file: 'guide.md', title: 'Setup' },
      ] } }],
      ['read_items', { command: 'read', arguments: { selections: [
        { kind: 'section', file: 'guide.md', title: 'Child' }, { kind: 'section', file: 'guide.md', title: 'Setup' },
      ], maxChars: 30 } }],
    ];
    for (const [name, query] of queries) {
      const result = await call(name, query.arguments);
      assert.deepEqual(result.data, presentResult(await f.service.execute(query), query));
      assert.equal(!!result.isError, !result.data.complete);
    }
    const traversal = await call('list_sections', { file: '../outside.md' });
    assert.equal(traversal.isError, true);
    const invalid = await call('read_section', { file: 'guide.md', id: 'setup', label: 'setup' });
    assert.equal(invalid.isError, true);
    const invalidTitle = await call('read_section', { file: 'guide.md', title: 'Setup', label: 'setup' });
    assert.equal(invalidTitle.isError, true);
    const injectedRoot = await call('list_notes', { root: f.directory });
    assert.equal(injectedRoot.isError, true);
    const invalidBatch = await call('read_items', { selections: [{ kind: 'section', file: 'guide.md', title: 'Setup', line: 8 }] });
    assert.equal(invalidBatch.isError, true);
    const original = await f.service.execute({ command: 'sections', arguments: { file: 'guide.md' } });
    assert.ok('sourceHash' in original);
    const oldHash = original.sourceHash;
    await fs.writeFile(path.join(f.root, 'guide.md'), source.replace('Parent.', 'Changed.'));
    const stale = await call('read_section', { file: 'guide.md', title: 'Setup', sourceHash: oldHash });
    assert.equal(stale.isError, true); assert.equal(stale.data.error.code, 'documentChanged');
    const fresh = await call('read_section', { file: 'guide.md', id: 'setup', includeChildren: false });
    assert.match(fresh.data.content, /Changed\./);
    const parallel = await Promise.all([call('list_terms'), call('list_glossaries'), call('list_notes')]);
    assert.ok(parallel.every(result => result.data.complete));
    await fs.writeFile(path.join(f.root, 'broken.md'), '---\na: 1\na: 2\n---\n# Broken\n');
    const scoped = await call('list_sections', { file: 'guide.md' });
    assert.equal(scoped.data.complete, true); assert.equal(scoped.isError, undefined); assert.equal(scoped.data.issues, undefined);
    const batch = await call('read_items', { selections: [
      { kind: 'section', file: 'guide.md', title: 'Setup' }, { kind: 'term', file: 'guide.md', name: 'Role' },
    ] });
    assert.equal(batch.data.complete, true); assert.equal(batch.isError, undefined); assert.equal(batch.data.issues, undefined);
    const global = await call('list_notes');
    assert.equal(global.isError, true); assert.equal(global.data.issues.length, 1);
    const local = await call('list_sections', { file: 'broken.md' });
    assert.equal(local.isError, true); assert.equal(local.data.issues[0].file, 'broken.md');
    assert.doesNotMatch(stderr, /internalError:|invalidRoot:|invalidArguments:/);
  } finally { await client.close(); await f.cleanup(); }
});

test('CLI mcp entry speaks legacy stdio, emits only JSON and exits on EOF', { timeout: 10000 }, async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [path.resolve('dist/cli.cjs'), 'mcp', '--root', f.root, '--cache-dir', f.cache]);
  let stdout = '', stderr = '';
  const closed = once(child, 'close');
  child.stderr.on('data', data => { stderr += data; });
  try {
    const pending = new Map<number, (value: any) => void>();
    let buffer = '';
    child.stdout.on('data', data => {
      stdout += data; buffer += data;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        pending.get(message.id)?.(message); pending.delete(message.id);
      }
    });
    const request = (id: number, method: string, params: unknown) => new Promise<any>(resolve => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const initialized = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } });
    assert.equal(initialized.result.serverInfo.name, 'markdown-chroma');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const terms = await request(2, 'tools/call', { name: 'list_terms', arguments: {} });
    assert.equal(terms.result.structuredContent.terms.length, 3);
    assert.ok(stdout.trim().split('\n').every(line => JSON.parse(line).jsonrpc === '2.0'));
    child.stdin.end();
    assert.equal((await closed)[0], 0);
    assert.doesNotMatch(stderr, /internalError:|invalidRoot:|invalidArguments:/);
  } finally { if (child.exitCode === null) child.kill(); await f.cleanup(); }
});

test('MCP startup rejects invalid roots and arguments without stdout', async () => {
  for (const args of [['--root', '/nonexistent/chroma-test-root'], ['--root'], ['--unknown']]) {
    await assert.rejects(execute(process.execPath, [path.resolve('dist/mcp.cjs'), ...args]), (error: any) => error.stdout === '' && /invalidRoot|invalidArguments/.test(error.stderr));
  }
});
