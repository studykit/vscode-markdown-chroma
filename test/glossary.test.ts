import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parseIndex, extract } from '../src/index/parser';
import { IndexService } from '../src/index/query';
import { presentResult } from '../src/index/presentation';
import { runCli } from '../src/index/cli';
import { assertRetrievalResult } from './retrieval-contract';

const definition = 'cache-node\n**캐시 노드**\nCache worker\nCACHE-NODE\n\n   A fictional **temporary** store.\n\n   A second paragraph with [[Related]].\n\n   - Saved records\n\n   | Key | Value |\n   | --- | --- |\n   | A | 1 |\n\n   ```text\n   [[Not a link]]\n   ```\n';
const source = `# Definitions\n\n:::{glossary}\n${definition}\nNext\n: An independent definition.\n:::\n`;

test('indented glossaries retain one canonical term, aliases and exact definition ranges', () => {
  for (const input of [source, source.replace(/:::/g, '````'), source.replace(/\n/g, '\r\n'), source.replace(/^   /gm, '    ')]) {
    const parsed = parseIndex('guide.md', input);
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.glossaries[0].termCount, 2);
    assert.deepEqual(parsed.terms.map(term => ({ name: term.name, aliases: term.aliases })), [
      { name: 'cache-node', aliases: ['캐시 노드', 'Cache worker'] }, { name: 'Next', aliases: [] },
    ]);
    const term = parsed.terms[0];
    const content = extract(input, term.startLine, term.endLine);
    assert.equal(content, definition.replace(/\n/g, input.includes('\r\n') ? '\r\n' : '\n').replace(/^   /gm, input.includes('    A fictional') ? '    ' : '   '));
    assert.deepEqual(parsed.outgoing.map(ref => ref.target), ['Related']);
    assert.equal(parsed.tables.length, 1);
  }
  assert.equal(parseIndex('plain.md', 'word\nalias\n\n   Description.').terms.length, 0);
  assert.ok(parseIndex('invalid.md', ':::{glossary}\nword\nalias\n:::').diagnostics.length);
  assert.equal(parseIndex('compact.md', ':::{glossary}\nword\nalias\n  Description.\n:::').terms[0].aliases[0], 'alias');
});

test('canonical and alias reads agree across CLI, API and real MCP, including collisions and saved updates', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'chroma-glossary-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'notes'), cache = path.join(directory, 'cache');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'guide.md'), source);
  await fs.writeFile(path.join(root, 'references.md'), '{term}`캐시 노드` {term}`shown <Cache worker>`\n');
  const service = new IndexService(root, cache);
  const query = { command: 'terms' as const, arguments: { file: 'guide.md', name: '캐시 노드' } };
  const listed = presentResult(await service.execute(query), query);
  assert.equal(listed.complete, true);
  assert.deepEqual((listed as any).terms[0].aliases, ['캐시 노드', 'Cache worker']);
  let stdout = '';
  assert.equal(await runCli(['terms', '--root', root, '--cache-dir', cache, '--name', 'Cache worker', '--json'],
    { stdout: value => { stdout += value; }, stderr: () => {} }), 0);
  assert.deepEqual(JSON.parse(stdout), listed);
  const read = await service.execute({ command: 'read-term', arguments: { names: ['cache-node', '캐시 노드', 'Cache worker'] } });
  assert.ok('items' in read);
  assert.equal(read.items.length, 1);
  assert.equal(read.items[0].status, 'ok');
  assert.equal((read.items[0] as any).content, definition);
  const batch = await service.execute({ command: 'read', arguments: { selections: [
    { kind: 'term', name: 'Cache worker' }, { kind: 'term', name: 'cache-node' },
  ] } });
  assert.ok('items' in batch);
  assert.equal(batch.items.length, 1);
  assert.equal((batch.items[0] as any).content, definition);
  const backlinks = await service.execute({ command: 'backlinks', arguments: { file: 'guide.md', term: 'term-cache-node' } });
  assert.ok('backlinks' in backlinks);
  assert.equal(backlinks.backlinks.length, 2);
  assert.ok(backlinks.backlinks.every(ref => ref.resolution?.targetId === 'guide.md#term-cache-node'));
  const client = new Client({ name: 'glossary-alias-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp.cjs'), '--root', root, '--cache-dir', cache, '--no-watch'], stderr: 'pipe' }));
    const terms = await client.callTool({ name: 'list_terms', arguments: { name: '캐시 노드', file: 'guide.md' } });
    assertRetrievalResult(terms.structuredContent);
    assert.deepEqual(terms.structuredContent, listed);
    const result = await client.callTool({ name: 'read_terms', arguments: { names: ['캐시 노드', 'Cache worker'] } });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as any).items[0].content, definition);
    assert.equal((result.structuredContent as any).items.length, 1);
    await fs.writeFile(path.join(root, 'other.md'), ':::{glossary}\nother-node\nCache worker\n\n   Different definition.\n:::\n');
    const ambiguous = await client.callTool({ name: 'read_terms', arguments: { names: ['Cache worker'] } });
    assert.equal((ambiguous.structuredContent as any).items[0].error.code, 'ambiguousTerm');
    const resolved = await client.callTool({ name: 'read_terms', arguments: { names: ['Cache worker'], file: 'guide.md' } });
    assert.equal((resolved.structuredContent as any).items[0].content, definition);
  } finally { await client.close(); }
  await fs.writeFile(path.join(root, 'guide.md'), source.replace('**캐시 노드**', '새 캐시 이름'));
  const updated = new IndexService(root, cache);
  const missing = await updated.execute({ command: 'read-term', arguments: { names: ['캐시 노드'] } });
  assert.ok('items' in missing);
  assert.equal((missing.items[0] as any).error.code, 'termNotFound');
  const refreshed = await updated.execute({ command: 'read-term', arguments: { names: ['새 캐시 이름'] } });
  assert.ok('items' in refreshed);
  assert.equal(refreshed.items[0].status, 'ok');
});
