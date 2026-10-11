import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { inspectPlugin } from '../src/index/plugins';
import { MarkdownIndex } from '../src/index/project';
import { IndexService, type IndexQuery } from '../src/index/query';
import { presentResult } from '../src/index/presentation';
import { runCli } from '../src/index/cli';
import { startHttp } from '../src/mcp/http';
import { assertRetrievalResult } from './retrieval-contract';

const javascript = `
import { writeFileSync } from 'node:fs';
const unregistered = { name: 'decoy' };
const directive = { name: 'custom:box', alias: ['custom:panel'], run() { throw Error('Do not run'); } };
const role = { name: 'custom:link', run: () => [] };
const plugin = { directives: [directive], roles: [role] };
export default plugin;
`;
const source = '# Plain\nPlain body.\n\n# Plugins\n{custom:link}`value`\n\n:::{custom:panel}\n# Generated heading\nBody.\n:::\n';
async function fixture(files: Record<string, string>) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'chroma-plugins-'));
  const root = path.join(directory, 'notes'), cache = path.join(directory, 'cache');
  await fs.mkdir(root);
  const write = async (file: string, content: string) => {
    const absolute = path.join(root, file); await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, content);
  };
  for (const [file, content] of Object.entries(files)) await write(file, content);
  const index = new MarkdownIndex(root, cache), service = new IndexService(root, cache);
  const query = async (query: IndexQuery) => presentResult(await service.execute(query), query) as any;
  const cli = async (...args: string[]) => {
    let stdout = '', stderr = '';
    const code = await runCli([...args, '--root', root, '--cache-dir', cache], { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
    return { code, stdout, stderr };
  };
  return { root, cache, directory, index, service, write, query, cli, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('static JS metadata follows exports and const references, without decoys, getters or dynamic guesses', () => {
  assert.deepEqual(inspectPlugin(javascript, 'javascript'), { directives: ['custom:box', 'custom:panel'], roles: ['custom:link'], transforms: false, unavailable: false });
  assert.deepEqual(inspectPlugin(`const specs = [{name:'one'}]; export default {directives:[...specs], roles:[{name:'two'}]}`, 'javascript').directives, ['one']);
  for (const dynamic of [
    `const decoy = {name:'decoy'}; export default makePlugin(decoy);`,
    `export default {get directives() {return [{name:'getter'}]}};`,
    `const plugin = {directives:[{name:'before'}]}; plugin.directives.push({name:'after'}); export default plugin;`,
    `const spec = {name:'before'}; spec.name='after'; export default {directives:[spec]};`,
    `const spec = {name:'before'}; const alias=spec; alias.name='after'; export default {directives:[spec]};`,
    `const spec = {name:'before'}; const alias=[spec]; alias[0].name='after'; export default {directives:[spec]};`,
    `const spec = {name:'before'}; let alias=spec; alias.name='after'; export default {directives:[spec]};`,
    `const plugin={directives:[{name:'before'}]}; const {directives}=plugin; directives[0].name='after'; export default plugin;`,
    `const spec = {name:'before'}; mutate([spec]); export default {directives:[spec]};`,
    `const a=b; const b=a; export default a;`,
    `export default {directives:[{...dynamicSpec,name:'guess'}]};`,
  ]) {
    const result = inspectPlugin(dynamic, 'javascript'); assert.deepEqual(result.directives, []); assert.equal(result.unavailable, true);
  }
});

test('Python literal specifications recognize names and aliases without running executable code', () => {
  const python = `#!/usr/bin/env python3\n# plugin = {'directives':[{'name':'comment'}]}\ntext = """\nplugin = {'directives':[{'name':'string'}]}\n"""\nplugin = {\n 'directives': [{'name': 'custom:python', 'alias': ['custom:py'], 'arg': {'required': False}}],\n}\nraise RuntimeError('Do not execute')\n`;
  assert.deepEqual(inspectPlugin(python, 'python'), { directives: ['custom:python', 'custom:py'], roles: [], transforms: false, unavailable: false });
  assert.deepEqual(inspectPlugin(`plugin = {'directives':[{'name':'\\141', '}': ']'}]}\n`, 'python').directives, ['a']);
  for (const dynamic of [
    `plugin = create_plugin()\n`,
    `plugin = {'directives': [{'name': generated_name}]}\n`,
    `plugin = {'directives': [{'name':'before'}]}\nplugin['directives'] = []\n`,
    `plugin = {'directives': [{'name':'before'}]} | other\n`,
    `plugin = {'directives': [{'name':'before'}]}\nalias=plugin\nalias['directives']=[]\n`,
  ]) assert.equal(inspectPlugin(dynamic, 'python').unavailable, true);
});

test('configured extensions become capability diagnostics, while typos, wrong kinds and code options remain syntax errors', async t => {
  const f = await fixture({ 'myst.yml': 'project:\n  plugins: [plugin.mjs]\n', 'plugin.mjs': javascript,
    'guide.md': source + '\n# Errors\n{custom:box}`wrong kind` {decoy}`unknown` {custom:lnik}`typo`\n\n```{code} python\n:lineos:\nprint(1)\n```\n', 'plain.md': '# Ordinary\nBody\n' }); t.after(f.cleanup);
  await f.index.refresh();
  const diagnostics = f.index.document('guide.md').diagnostics;
  assert.equal(diagnostics.filter(d => d.code === 'pluginContentNotIndexed').length, 2);
  const syntax = diagnostics.filter(d => d.code === 'mystSyntax').map(d => d.message);
  assert.equal(syntax.length, 4); assert.ok(syntax.some(m => m.includes('lineos')));
  assert.ok(syntax.includes('unknown role: custom:box')); assert.ok(syntax.includes('unknown role: decoy')); assert.ok(syntax.includes('unknown role: custom:lnik'));
  assert.deepEqual(f.index.document('guide.md').sections.map(s => s.title), ['Plain', 'Plugins', 'Errors']);
  assert.deepEqual(f.index.document('plain.md').diagnostics, []);
  const outline = await f.query({ command: 'sections', arguments: { file: 'guide.md' } });
  assert.equal(outline.complete, false); assert.equal(outline.issues.length, 1); assert.match(outline.issues[0].message, /plugins are not executed/);
  const read = await f.cli('read-section', 'guide.md', '--title', 'Plugins');
  assert.equal(read.code, 0); assert.equal(read.stderr, ''); assert.equal(read.stdout, source.slice(source.indexOf('# Plugins')) + '\n');
  const debug = await f.cli('read-section', 'guide.md', '--title', 'Plugins', '--debug');
  assert.equal(debug.code, 1); assert.ok(JSON.parse(debug.stdout).diagnostics.some((d: any) => d.code === 'pluginContentNotIndexed'));
  const raw = await f.query({ command: 'read-lines', arguments: { file: 'guide.md', startLine: 1, endLine: 100 } });
  assert.equal(raw.complete, true); assert.equal(raw.issues, undefined);
});

test('plugin paths follow inherited config and nearest config; saved-source reads remain complete', async t => {
  const f = await fixture({ 'myst.yml': 'extends: config/base.yml\n', 'config/base.yml': 'project:\n  plugins: [plugin.mjs]\n', 'config/plugin.mjs': javascript,
    'sub/guide.md': source, 'sub/page.md': '---\nplugins: [page.mjs]\n---\n# Page\n{page}`value`\n',
    'sub/page.mjs': `export default {roles:[{name:'page', run:()=>[]}]};`,
    'sub/override/myst.yml': 'project:\n  plugins: []\n', 'sub/override/guide.md': source }); t.after(f.cleanup);
  await f.index.refresh();
  assert.ok(!f.index.document('sub/guide.md').diagnostics.some(d => d.code === 'mystSyntax'));
  assert.ok(f.index.document('sub/override/guide.md').diagnostics.some(d => d.code === 'mystSyntax'));
  assert.ok(!f.index.document('sub/page.md').diagnostics.some(d => d.code === 'mystSyntax'));
  const sections = await f.query({ command: 'sections', arguments: { file: 'sub/guide.md' } });
  assert.equal(sections.complete, false); assert.match(sections.issues[0].message, /generated content/);
  for (const query of [
    { command: 'read-section', arguments: { file: 'sub/guide.md', title: 'Plugins' } },
    { command: 'read', arguments: { selections: [{ kind: 'section', file: 'sub/guide.md', title: 'Plugins' }] } },
    { command: 'read-frontmatter', arguments: { file: 'sub/guide.md' } },
  ] as IndexQuery[]) {
    const result = await f.query(query); assert.equal(result.complete, true); assert.equal(result.issues, undefined); assertRetrievalResult(result);
  }
});

test('plugin source changes, removal and unavailable definitions invalidate warm snapshots conservatively', async t => {
  const f = await fixture({ 'myst.yml': 'project:\n  plugins: [plugin.mjs]\n', 'plugin.mjs': javascript, 'guide.md': source }); t.after(f.cleanup);
  await f.index.refresh(); await f.index.refresh(); assert.equal(f.index.stats.reused, 1);
  await f.write('plugin.mjs', javascript.replaceAll('custom:link', 'custom:new'));
  await f.index.refresh(); assert.equal(f.index.stats.parsed, 1);
  assert.ok(f.index.document('guide.md').diagnostics.some(d => d.message === 'unknown role: custom:link'));
  await f.write('plugin.mjs', 'export default buildDynamicPlugin();'); await f.index.refresh();
  assert.ok(f.index.document('guide.md').diagnostics.some(d => d.code === 'pluginDefinitionsUnavailable'));
  assert.equal((await f.query({ command: 'sections', arguments: { file: 'guide.md' } })).complete, false);
  await fs.rm(path.join(f.root, 'plugin.mjs')); await f.index.refresh(); assert.equal(f.index.stats.parsed, 1);
  await f.write('plugin.mjs', javascript); await f.index.refresh();
  assert.ok(!f.index.document('guide.md').diagnostics.some(d => d.code === 'mystSyntax'));
  assert.ok(!f.index.document('guide.md').diagnostics.some(d => d.code === 'pluginDefinitionsUnavailable'));
});

test('configured plugins use bounded root-bound reads and never execute JS or Python', async t => {
  const f = await fixture({ 'myst.yml': 'project:\n  plugins:\n    - safe.mjs\n    - type: executable\n      path: safe.py\n    - missing.mjs\n    - linked.mjs\n    - ../outside.mjs\n    - node_modules/excluded.mjs\n    - https://example.invalid/plugin.mjs\n',
    'guide.md': source + '\n:::{custom:py}\n:::\n', 'safe.py': `plugin = {'directives': [{'name':'custom:py'}]}\nraise RuntimeError('Do not run')\n`,
    'node_modules/excluded.mjs': javascript }); t.after(f.cleanup);
  const marker = path.join(f.directory, 'executed');
  await f.write('safe.mjs', `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'BAD');\n` + javascript.replace("import { writeFileSync } from 'node:fs';", ''));
  await fs.writeFile(path.join(f.directory, 'outside.mjs'), javascript);
  await fs.symlink(path.join(f.directory, 'outside.mjs'), path.join(f.root, 'linked.mjs'));
  await f.index.refresh();
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  const diagnostics = f.index.document('guide.md').diagnostics;
  assert.ok(!diagnostics.some(d => d.code === 'mystSyntax')); assert.ok(diagnostics.some(d => d.code === 'pluginDefinitionsUnavailable'));
  assert.equal((await f.query({ command: 'read-section', arguments: { file: 'guide.md', title: 'Plain' } })).complete, false);
  await f.write('safe.mjs', 'x'.repeat(2 * 1024 * 1024 + 1)); await f.index.refresh();
  assert.ok(f.index.document('guide.md').diagnostics.some(d => d.message === 'unknown role: custom:link'));
});

test('plugin transforms keep structural discovery partial but preserve exact saved source', async t => {
  const f = await fixture({ 'myst.yml': 'project:\n  plugins: [transform.mjs]\n',
    'transform.mjs': `export default {transforms: [{name:'headings', stage:'document', plugin() { throw Error('Do not run'); }}]};`,
    'guide.md': '# Plain\n**Source**\n', 'glossary.md': '# Terms\n\n:::{glossary}\nAST\n: Tree.\n:::\n' }); t.after(f.cleanup);
  const outline = await f.query({ command: 'sections', arguments: { file: 'guide.md' } });
  assert.equal(outline.complete, false); assert.match(outline.issues[0].message, /generated content/);
  const read = await f.query({ command: 'read-section', arguments: { file: 'guide.md', title: 'Plain' } });
  assert.equal(read.complete, true); assert.equal(read.content, '# Plain\n**Source**\n');
  for (const query of [
    { command: 'read-term', arguments: { names: ['AST'] } },
    { command: 'read', arguments: { selections: [{ kind: 'term', name: 'AST' }] } },
  ] as IndexQuery[]) {
    const result = await f.query(query); assert.equal(result.complete, false); assert.match(result.issues[0].message, /generated content/);
  }
  const term = await f.query({ command: 'read-term', arguments: { names: ['AST'], file: 'glossary.md' } });
  assert.equal(term.complete, true); assert.match(term.items[0].content, /Tree/);
});

for (const transportKind of ['stdio', 'http'] as const) test(`${transportKind} MCP distinguishes plugin limitations from source-read completeness`, { timeout: 15000 }, async () => {
  const f = await fixture({ 'myst.yml': 'project:\n  plugins: [plugin.mjs]\n', 'plugin.mjs': javascript, 'guide.md': source });
  const client = new Client({ name: 'plugin-test', version: '1' });
  const http = transportKind === 'http' ? await startHttp(f.service, { host: '127.0.0.1', port: 0, allowedHosts: ['127.0.0.1'], allowedOrigins: ['127.0.0.1'] }, () => {}) : undefined;
  const transport = http ? new StreamableHTTPClientTransport(new URL(http.url))
    : new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp.cjs'), '--root', f.root, '--cache-dir', f.cache], stderr: 'pipe' });
  let stderr = ''; if (transport instanceof StdioClientTransport) transport.stderr?.on('data', data => { stderr += data; });
  try {
    await client.connect(transport);
    for (const [name, query] of [
      ['list_sections', { command: 'sections', arguments: { file: 'guide.md' } }],
      ['read_section', { command: 'read-section', arguments: { file: 'guide.md', title: 'Plugins' } }],
      ['read_items', { command: 'read', arguments: { selections: [{ kind: 'section', file: 'guide.md', title: 'Plugins' }] } }],
    ] as [string, IndexQuery][]) {
      const result = await client.callTool({ name, arguments: query.arguments });
      const data = result.structuredContent as any; assertRetrievalResult(data);
      assert.deepEqual(data, await f.query(query));
      assert.equal(!!result.isError, query.command === 'sections');
      if (query.command === 'sections') assert.match(data.issues[0].message, /generated content/);
      else assert.equal(data.issues, undefined);
    }
    assert.equal(stderr, '');
  } finally { await client.close(); await http?.close(); await f.cleanup(); }
});
