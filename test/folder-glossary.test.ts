import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { JSDOM } from 'jsdom';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { IndexService } from '../src/index/query';
import { runCli } from '../src/index/cli';
import { presentResult } from '../src/index/presentation';
import { extendMystMarkdown } from '../src/myst';
import { matchFolderGlossary, parseFolderGlossaryConfig } from '../src/folder-glossary';
import { parseIndex } from '../src/index/parser';
import { fixture } from './helpers';

const config = 'version: 1\nglossaries:\n  - include: "Glossary/*.md"\n    definitionHeading: Definition\n';
const definition = '## Definition\n\nA chat room.\n\n### Scope\n\nConversation only.\n\n';
const chat = `---\naliases: [채팅방, 챗방]\nreviewed: false\n---\n\n# Chat\n\n${definition}## Examples\n\nNot in the definition.\n`;
const termReference = '{term}`채팅방`';
const files = {
  'chroma.index.yml': config,
  'Glossary/chat.md': chat,
  'Glossary/call.md': '# Call\n\n## Definition\n\nA voice call.\n',
  'Glossary/sub/excluded.md': chat,
  'Main.md': termReference + '\n\n:::{glossary}\nLegacy\n: A legacy definition.\n:::\n',
};

test('folder rules are root-relative and only a unique document-level definition supplies a folder term', () => {
  const parsed = parseFolderGlossaryConfig(config);
  assert.equal(parsed.error, undefined);
  assert.equal(matchFolderGlossary(parsed, 'Glossary/chat.md').heading, 'Definition');
  assert.equal(matchFolderGlossary(parsed, 'Glossary/sub/chat.md').heading, undefined);
  assert.match(parseFolderGlossaryConfig(config.replace('Glossary/*.md', '../outside/*.md')).error ?? '', /root-relative/);
  const overlap = parseFolderGlossaryConfig(config + '  - include: "Glossary/**"\n    definitionHeading: Other\n');
  assert.ok(matchFolderGlossary(overlap, 'Glossary/chat.md').error);
  const rule = matchFolderGlossary(parsed, 'Glossary/chat.md');
  const ambiguous = parseIndex('Glossary/chat.md', chat + '\n' + definition, {}, undefined, rule);
  assert.equal(ambiguous.terms.length, 0);
  assert.match(ambiguous.diagnostics[0].message, /exactly one/);
  const mixed = parseIndex('Glossary/chat.md', chat + '\n:::{term-def} chat\nOld duplicate.\n:::\n', {}, undefined, rule);
  assert.deepEqual(mixed.terms.map(term => term.id), ['Glossary/chat.md#definition']);
  const invalidReview = parseIndex('Glossary/chat.md', chat.replace('reviewed: false', 'reviewed: "false"'), {}, undefined, rule);
  assert.equal(invalidReview.terms[0].reviewed, undefined);
  assert.match(invalidReview.diagnostics[0].message, /boolean/);
});

test('folder term review filtering, definition reads and links agree across CLI, API and MCP', async t => {
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'chroma-folder-glossary-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'root'), cache = path.join(scratch, 'cache');
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
  }
  const service = new IndexService(root, cache);
  const query = { command: 'terms' as const, arguments: { reviewed: false, name: '채팅방' } };
  const expected = { complete: true, terms: [
    { id: 'Glossary/chat.md#definition', name: 'chat', aliases: ['채팅방', '챗방'], reviewed: false, file: 'Glossary/chat.md' },
  ] };
  assert.deepEqual(presentResult(await service.execute(query), query), expected);
  const all = await service.execute({ command: 'terms', arguments: {} });
  assert.ok('terms' in all);
  assert.deepEqual(all.terms.map(term => [term.name, term.reviewed]), [['call', true], ['chat', false], ['Legacy', undefined]]);
  const reviewed = await service.execute({ command: 'terms', arguments: { reviewed: true } });
  assert.ok('terms' in reviewed && reviewed.terms.length === 1 && reviewed.terms[0].name === 'call');
  let stdout = '', stderr = '';
  const io = { stdout: (value: string) => { stdout += value; }, stderr: (value: string) => { stderr += value; } };
  assert.equal(await runCli(['terms', '--reviewed=false', '--name', '채팅방', '--json', '--root', root, '--cache-dir', cache], io), 0);
  assert.deepEqual(JSON.parse(stdout), expected);
  stdout = '';
  assert.equal(await runCli(['read-term', '채팅방', '--root', root, '--cache-dir', cache], io), 0);
  assert.equal(stdout, definition);
  assert.match(stderr, /unreviewed/);
  const client = new Client({ name: 'folder-glossary-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp.cjs'), '--root', root, '--cache-dir', cache, '--no-watch'], stderr: 'pipe' }));
    assert.deepEqual((await client.callTool({ name: 'list_terms', arguments: query.arguments })).structuredContent, expected);
    const read = await client.callTool({ name: 'read_terms', arguments: { ids: ['Glossary/chat.md#definition'] } });
    assert.deepEqual(read.structuredContent, { complete: true, items: [
      { kind: 'term', file: 'Glossary/chat.md', name: 'chat', reviewed: false, content: definition },
    ] });
    const batch = await client.callTool({ name: 'read_items', arguments: { selections: [{ kind: 'term', name: '챗방' }] } });
    assert.deepEqual(batch.structuredContent, read.structuredContent);
  } finally { await client.close(); }
  const backlinks = await service.execute({ command: 'backlinks', arguments: { file: 'Glossary/chat.md', term: 'definition' } });
  assert.ok('backlinks' in backlinks && backlinks.backlinks.some(reference => reference.resolution?.targetId === 'Glossary/chat.md#definition'));
  await fs.writeFile(path.join(root, 'Glossary/chat.md'), chat.replace('reviewed: false\n', ''));
  const updated = await service.execute(query);
  assert.ok('terms' in updated && updated.terms.length === 0);
  await fs.writeFile(path.join(root, 'chroma.index.yml'), config.replace('definitionHeading: Definition', 'definitionHeading: Examples'));
  const updatedTerm = await service.execute({ command: 'terms', arguments: { file: 'Glossary/chat.md', reviewed: true } });
  assert.ok('terms' in updatedTerm && updatedTerm.terms[0].id === 'Glossary/chat.md#examples');
});

test('folder terms resolve to the native section anchor and refresh after rule and dirty-buffer changes', async t => {
  const f = await fixture(t, { ...files,
    'chroma.index.yml': config + '  - include: "Glossary/*.markdown"\n    definitionHeading: Definition\n',
    'Glossary/room.markdown': '\uFEFF' + chat.replace('채팅방, 챗방', '채널'),
  });
  extendMystMarkdown(f.md, f.host);
  const render = (source: string, file?: string) => new JSDOM(f.render(source, file)).window.document;
  assert.equal(render(termReference).querySelector('a')?.getAttribute('href'), 'Glossary/chat.md#definition');
  assert.equal(render('{term}`채널`').querySelector('a')?.getAttribute('href'), 'Glossary/room.markdown#definition');
  const mixed = chat.replace('## Examples', ':::{term-def} chat\nOld duplicate.\n:::\n\n## Examples');
  const local = render(mixed + '\n' + termReference, 'Glossary/chat.md');
  assert.equal(local.querySelector('a')?.getAttribute('href'), '#definition');
  assert.ok(local.querySelector('h2#definition.code-line'));
  assert.ok(render(files['Main.md'] + '\n{term}`Legacy`').querySelector('a[href="#term-legacy"]'));
  f.dirty.set(path.join(f.root, 'Glossary/chat.md'), chat.replace('채팅방', '새 별칭'));
  assert.equal(render('{term}`새 별칭`').querySelector('a')?.getAttribute('href'), 'Glossary/chat.md#definition');
  await fs.writeFile(path.join(f.root, 'chroma.index.yml'), config.replace('definitionHeading: Definition', 'definitionHeading: Examples'));
  await f.vault.refresh();
  assert.equal(render('{term}`새 별칭`').querySelector('a')?.getAttribute('href'), 'Glossary/chat.md#examples');
});
