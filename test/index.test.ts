import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseIndex, extract, hash } from '../src/index/parser';
import { MarkdownIndex } from '../src/index/project';
import { runCli } from '../src/index/cli';

const execute = promisify(execFile);
async function fixture(files: Record<string, string>) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'chroma-index-test-'));
  const root = path.join(directory, 'notes'), cache = path.join(directory, 'cache');
  await fs.mkdir(root);
  const write = async (file: string, content: string) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), content); };
  for (const [file, content] of Object.entries(files)) await write(file, content);
  const index = new MarkdownIndex(root, cache);
  const cli = async (...args: string[]) => {
    let stdout = '', stderr = '';
    const code = await runCli([...args, '--root', root, '--cache-dir', cache], { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
    return { code, stdout, stderr, json: () => JSON.parse(stdout) };
  };
  return { root, cache, directory, index, write, cli, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('sections retain labels, hierarchy, Setext, reserved IDs, CRLF and raw ranges', () => {
  const source = '---\r\ntitle: Title\r\n---\r\nIntro.\r\n\r\n(setup)=\r\n# 설치\r\nParent.\r\n## Child\r\nChild body.\r\n\r\n::: {note}\r\n# Hidden heading\r\n::: \r\n\r\n설치\r\n====\r\nSecond.\r\n\r\n# preamble\r\nFinal';
  const document = parseIndex('guide.md', source);
  assert.deepEqual(document.sections.map(s => s.id), ['preamble', '설치', 'child', '설치-1', 'preamble-1']);
  assert.deepEqual(document.sections[2].headingPath, ['설치', 'Child']);
  assert.deepEqual(document.sections[1].labels, ['setup']);
  assert.equal(extract(source, document.sections[1].startLine, document.sections[1].ownEndLine), '(setup)=\r\n# 설치\r\nParent.\r\n');
  assert.ok(extract(source, document.sections[1].startLine, document.sections[1].endLine).includes('# Hidden heading'));
  assert.equal(extract(source, document.sections.at(-1)!.startLine, document.sections.at(-1)!.endLine), '# preamble\r\nFinal');
  assert.equal(parseIndex('empty.md', '---\na: 1\n---\n').sections.length, 0);
  assert.equal(parseIndex('body.md', 'Body only').sections[0].id, 'preamble');
  assert.equal(parseIndex('mixed-heading.md', '# [[Guide|문서]] #태그\n').sections[0].title, '문서 #태그');
});

test('mixed tokenizer collects semantic content once and ignores code, math, comments and escapes', () => {
  const source = '# Main\n[[A *bold* name]] ![[a.png]] #한글/Sub #123\n\\[[escaped]] \\#escaped `[[inline]] #inline` $[[math]] \\#math$\n<!-- [[html]] #html -->\n% [[comment]] #comment\n\n:::{note}\n[[Nested]] #nested\n:::\n\n> [!note]\n> [[Callout]] #callout\n\n:::{code} md\n[[code]] #code\n:::\n\n```md\n[[fence]] #fence\n```\n\n[link](other.md#fragment) https://example.com/#fragment\n';
  const document = parseIndex('a.md', source);
  assert.deepEqual(document.tags.map(t => t.normalized), ['한글/sub', 'nested', 'callout']);
  assert.deepEqual(document.outgoing.map(r => r.target), ['A *bold* name', 'a.png', 'Nested', 'Callout', 'other.md']);
  assert.equal(document.outgoing[0].raw, '[[A *bold* name]]');
  assert.equal(document.outgoing[2].startLine, 8);
  assert.equal(document.outgoing[3].startLine, 12);
  assert.equal(document.images.length, 1);
});

test('built CLI handles internationalized URLs without loading deprecated punycode', async t => {
  const source = '# <https://xn--maana-pta.com>\n\n![Remote](https://mañana.com/picture.png)\n';
  const f = await fixture({ 'urls.md': source }); t.after(f.cleanup);
  const env = { ...process.env }; delete env.NODE_NO_WARNINGS; delete env.NODE_OPTIONS;
  const cli = async (...args: string[]) => {
    const result = await execute(process.execPath, ['--pending-deprecation', path.resolve('dist/cli.cjs'), ...args,
      '--root', f.root, '--cache-dir', f.cache], { env });
    assert.doesNotMatch(result.stderr, /DEP0040|punycode.*deprecated/);
    return result.stdout;
  };
  const sections = JSON.parse(await cli('sections', 'urls.md', '--debug'));
  assert.equal(sections.sections[0].title, 'https://mañana.com');
  const images = JSON.parse(await cli('images', 'urls.md', '--json'));
  assert.equal(images.images[0].source, 'https://xn--maana-pta.com/picture.png');
  assert.equal(await cli('read-section', 'urls.md', '--title', 'https://mañana.com'), source);
});

test('tables and images survive layout containers without wrapper duplicates', () => {
  const source = '# Content\n\n::::{grid} 1\n(layout)=\n:::{grid-item}\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n![A](a.png)\n![Again][asset]\n\n:::\n::::\n\n[asset]: a.png\n\n:::{list-table} Caption\n:name: list\n:header-rows: 1\n\n* - H1\n  - H2\n* - V1\n  - V2\n:::\n\n:::{table} Named\n:name: pipe\n\n| A | B |\n| - | - |\n| 1 | 2 |\n:::\n\n:::{csv-table} CSV\n:header: X, Y\n\n1,2\n3,4\n:::\n\n:::{figure}\n:name: multi\n\n![First](first.png)\n![Second](second.png)\n\nGroup caption.\n:::\n\n:::{figure} generated.png\n:name: generated\n\nGenerated caption.\n:::\n\n:::{image} direct.png\n:alt: Direct\n:::\n';
  const document = parseIndex('a.md', source);
  assert.equal(document.diagnostics.length, 0);
  assert.equal(document.tables.length, 4);
  assert.deepEqual(document.tables.map(t => t.syntax), ['markdown', 'myst-list-table', 'myst-table', 'myst-csv-table']);
  assert.deepEqual(document.tables.map(t => t.rowCount), [2, 2, 2, 3]);
  assert.deepEqual(document.tables[1].headers, ['H1', 'H2']);
  assert.equal(document.tables[1].caption, 'Caption');
  assert.equal(document.tables[1].labels[0], 'list');
  assert.equal(document.images.length, 6);
  assert.deepEqual(document.images.slice(2, 4).map(i => i.figure?.labels), [['multi'], ['multi']]);
  assert.equal(document.images[2].figure?.id, document.images[3].figure?.id);
  assert.notEqual(document.images[2].startLine, document.images[3].startLine);
  assert.equal(document.images[2].figure?.caption, 'Group caption.');
  assert.ok(!document.targets.some(target => target.label === 'layout'));
});

test('glossary definitions include paragraphs, lists, tables and exclude adjacent terms', () => {
  const source = '# Definitions\n\n{term}`shown <MyST Markdown>`\n\n(terms)=\n:::{glossary}\nMyST Markdown\n: First paragraph.\n\n    Second paragraph.\n\n    - Bullet [[Related]]\n\n    | A | B |\n    | - | - |\n    | 1 | 2 |\n\nNext\n: Definition.\n:::\n\nOutside\n: Not a glossary term.\n';
  const document = parseIndex('terms #.md', source);
  assert.equal(document.terms.length, 2);
  assert.equal(document.glossaries[0].termCount, 2);
  assert.equal(document.glossaries[0].startLine, 5);
  const first = document.terms[0];
  assert.equal(first.id, 'terms%20%23.md#term-myst-markdown');
  assert.equal(first.identifier, 'term-myst markdown');
  const content = extract(source, first.startLine, first.endLine);
  assert.ok(content.includes('Second paragraph.') && content.includes('Bullet') && content.includes('| 1 | 2 |'));
  assert.ok(!content.includes('Next') && !content.includes(':::'));
  assert.equal(document.tables.length, 1);
  assert.equal(document.outgoing[0].target, first.identifier);
  assert.equal(document.outgoing[1].target, 'Related');
});

test('tag and typed property filters combine with AND; null counts as a property', async t => {
  const f = await fixture({ 'a.md': '---\ntags: [Project/Sub]\nstatus: draft\nnumber: 7\nflag: true\nauthor: null\nchoices: [x, y]\n---\n# A\n#본문\n', 'b.md': '---\ntags: project\nstatus: published\nnumber: "7"\n---\n# B\n' }); t.after(f.cleanup);
  assert.deepEqual((await f.cli('search', '--debug', '--tag', 'PROJECT')).json().notes.map((n: any) => n.file), ['a.md', 'b.md']);
  assert.deepEqual((await f.cli('search', '--debug', '--tag', 'project', '--exact-tag')).json().notes.map((n: any) => n.file), ['b.md']);
  assert.equal((await f.cli('search', '--debug', '--tag', 'project', '--where', '{"number":7,"flag":true,"choices":"y"}', '--has-property', 'author')).json().notes[0].file, 'a.md');
  assert.equal((await f.cli('search', '--debug', '--where', '{"number":"7"}')).json().notes[0].file, 'b.md');
  assert.equal((await f.cli('search', '--debug', '--where', '{"author":null}')).json().notes.length, 1);
  assert.equal((await f.cli('search', '--debug', '--where', '{"absent":null}')).json().notes.length, 0);
  assert.equal((await f.cli('search', '--debug', '--where', '{"a":[]}')).code, 2);
});

test('backlinks resolve files, aliases, sections, term targets and ambiguous references in a second pass', async t => {
  const f = await fixture({
    'source.md': '# Source\n[[Target#Part]] [[Alias]] [[Dup]] [[Target#^block]] [local](Target.md#part)\n{term}`shown <MyST Markdown>` {term}`Missing` {ref}`part-label` @part-label @unclassified\n',
    'Target.md': '---\naliases: Alias\n---\n# Target\n(part-label)=\n## Part\n\n:::{glossary}\nMyST Markdown\n: A definition.\n:::\n', 'one/Dup.md': '# One\n', 'two/Dup.md': '# Two\n',
  }); t.after(f.cleanup); await f.index.refresh();
  const refs = f.index.document('source.md').outgoing;
  assert.equal(refs.find(r => r.target === 'Dup')!.resolution!.status, 'ambiguous');
  assert.equal(refs.find(r => r.fragment === '^block')!.resolution!.fragmentStatus, 'notIndexed');
  assert.equal(refs.find(r => r.kind === 'term' && r.target === 'term-myst markdown')!.resolution!.targetId, 'Target.md#term-myst-markdown');
  assert.equal(refs.find(r => r.target === 'part-label' && r.kind === 'citation')!.resolution!.targetKind, 'section');
  assert.equal(f.index.backlinks(f.index.document('Target.md')).length, 7);
  assert.equal(f.index.backlinks(f.index.document('Target.md'), 'term-myst-markdown').length, 1);
  assert.equal((await f.cli('notes', '--debug', '--unresolved')).json().notes[0].file, 'source.md');
  await f.write('Target.md', '# Changed\n'); await f.index.refresh();
  assert.equal(f.index.document('source.md').outgoing.find(r => r.target === 'Alias')!.resolution!.status, 'missing');
  assert.equal(f.index.document('source.md').outgoing.find(r => r.kind === 'term')!.resolution!.status, 'missing');
});

test('wiki precedence, explicit paths and ordinary links use their documented bases', async t => {
  const f = await fixture({ 'Name.md': '# Root\n', 'sub/Name.md': '# Local\n', 'sub/source.md': '[[Name]] [[Name.md]] [[./Name]] [[../Name]] [[sub/Name]] [relative](Name.md) [outside](../../outside.md)\n', 'deep/unique.md': '---\naliases: [Chosen]\n---\nUnique\n' }); t.after(f.cleanup); await f.index.refresh();
  const refs = f.index.document('sub/source.md').outgoing;
  assert.deepEqual(refs.slice(0, 6).map(r => r.resolution?.file), ['sub/Name.md', 'sub/Name.md', 'sub/Name.md', 'Name.md', 'sub/Name.md', 'sub/Name.md']);
  assert.equal(refs[6].resolution?.status, 'outside');
  assert.equal(f.index.resolveFile('Chosen', 'sub/source.md', true).file, 'deep/unique.md');
});

test('CLI supports project-wide lists, batch/mixed reads, duplicates and partial ambiguity', async t => {
  const a = '(g)=\n:::{glossary}\nAST\n: First definition.\n\nRole\n: A role.\n:::\n';
  const b = ':::{glossary}\nAST\n: Other definition.\n\nUnique\n: Unique definition.\n:::\n';
  const f = await fixture({ 'a.md': a, 'b.md': b }); t.after(f.cleanup);
  assert.equal((await f.cli('glossaries', '--debug')).json().glossaries.length, 2);
  assert.equal((await f.cli('terms', '--debug')).json().terms.length, 4);
  assert.equal((await f.cli('terms', '--debug', 'a.md', '--glossary', 'glossary-1')).json().terms.length, 2);
  assert.equal((await f.cli('terms', '--debug', '--glossary', 'b.md#glossary-1')).json().terms.length, 2);
  const partial = await f.cli('read-term', 'Unique', 'AST', 'Missing', '--debug');
  assert.equal(partial.code, 1); assert.equal(partial.json().complete, false);
  assert.deepEqual(partial.json().items.map((i: any) => i.status), ['ok', 'error', 'error']);
  assert.equal(partial.json().items[1].error.code, 'ambiguousTerm');
  assert.equal(partial.json().items[1].error.details.length, 2);
  assert.equal((await f.cli('read-term', 'AST', '--file', 'a.md')).stdout, 'AST\n: First definition.\n');
  const mixed = (await f.cli('read', '--id', 'b.md#term-unique', '--id', 'a.md#glossary-1', '--id', 'b.md#term-unique', '--id', 'a.md#term-role', '--debug')).json();
  assert.deepEqual(mixed.items.map((i: any) => i.kind), ['term', 'glossary', 'term']);
  assert.equal(mixed.items[1].content, a);
  assert.equal((await f.cli('read-glossary', '--id', 'a.md#glossary-1', '--id', 'b.md#glossary-1', '--debug')).json().items.length, 2);
  const markdown = await f.cli('read-term', '--id', 'a.md#term-role', '--id', 'b.md#term-unique');
  assert.ok(markdown.stdout.includes('a.md') && markdown.stdout.includes('b.md') && markdown.stdout.includes('Unique definition.'));
  assert.ok(!markdown.stdout.includes('term-role') && !markdown.stdout.includes('term-unique'));
  assert.equal((await f.cli('read-term', '--id', 'a.md#term-role', 'Role', '--debug')).code, 2);
  assert.equal((await f.cli('read-term', '--id', 'a.md#term-role', '--id', 'b.md#term-unique', '--source-hash', hash(a), '--debug')).code, 2);
});

test('section reads verify fresh source hashes and section-scoped lists include descendants', async t => {
  const source = '(parent)=\n# Parent\nBody\n## Child\n![Image](a.png)\n# Next\nEnd\n';
  const f = await fixture({ 'a.md': source, 'a.png': 'image' }); t.after(f.cleanup);
  const listed = (await f.cli('sections', 'a.md', '--debug')).json();
  const read = await f.cli('read-section', 'a.md', '--label', 'parent', '--no-children', '--source-hash', listed.sourceHash, '--debug');
  assert.equal(read.json().content, '(parent)=\n# Parent\nBody\n');
  assert.equal((await f.cli('images', '--debug', 'a.md', '--section', 'parent')).json().images.length, 1);
  assert.equal((await f.cli('images', '--debug', 'a.md', '--section', 'next')).json().images.length, 0);
  await f.write('a.md', source.replace('Body', 'Changed'));
  const stale = await f.cli('read-section', 'a.md', '--title', 'Parent', '--source-hash', listed.sourceHash, '--debug');
  assert.equal(stale.code, 1); assert.equal(stale.json().error.code, 'documentChanged');
  assert.equal((await f.cli('sections', '../outside.md', '--debug')).json().error.code, 'outsideRoot');
});

test('CLI sections list titles by hierarchy and title reads retain exact source and debug metadata', async t => {
  const source = 'Intro.\r\n\r\n(parent)=\r\n# **설치**\r\nParent body.\r\n### macOS\r\nChild body.\r\n# End\r\nDone.\r\n';
  const f = await fixture({ 'guide.md': source, 'empty.md': '', 'body.md': 'Body only.' }); t.after(f.cleanup);
  const outline = await f.cli('sections', 'guide.md');
  assert.equal(outline.code, 0);
  assert.equal(outline.stdout, '[preamble]\n설치\n  macOS\nEnd\n');
  assert.equal(outline.stderr, '');
  const detailed = (await f.cli('sections', 'guide.md', '--debug')).json();
  assert.equal(detailed.complete, true);
  assert.equal(detailed.sourceHash, hash(source));
  assert.deepEqual(detailed.sections[1].labels, ['parent']);
  assert.ok(detailed.sections[1].ownEndLine < detailed.sections[1].endLine);
  const own = await f.cli('read-section', 'guide.md', '--title', '설치', '--no-children');
  assert.equal(own.code, 0);
  assert.equal(own.stdout, '(parent)=\r\n# **설치**\r\nParent body.\r\n');
  assert.equal((await f.cli('read-section', 'guide.md', '--title', 'macOS')).stdout, '### macOS\r\nChild body.\r\n');
  assert.equal((await f.cli('read-section', 'guide.md', '--title', 'end', '--debug')).json().error.code, 'sectionNotFound');
  assert.equal((await f.cli('sections', 'empty.md')).stdout, '');
  assert.equal((await f.cli('sections', 'body.md')).stdout, '[preamble]\n');
  assert.equal((await f.cli('read-section', 'body.md', '--id', 'preamble')).stdout, 'Body only.');
  for (const args of [
    ['--title', 'macOS', '--id', 'macos'], ['--title', 'macOS', '--label', 'parent'],
    ['--title', 'macOS', '--heading-path', '["설치","macOS"]'], ['--title', 'macOS', '--title', 'End'],
    ...['broken', 'null', '[]', '[""]', '["설치",2]'].map(value => ['--heading-path', value])
  ]) assert.equal((await f.cli('read-section', 'guide.md', ...args, '--debug')).code, 2);
  const missing = await f.cli('sections', 'missing.md');
  assert.equal(missing.code, 1); assert.equal(missing.stdout, ''); assert.match(missing.stderr, /fileNotFound/);
  const invalid = await f.cli('sections');
  assert.equal(invalid.code, 2); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /invalidArguments/);
});

test('duplicate section titles require paths, identical paths require IDs, and errors retain candidates', async t => {
  const source = '# Linux > Desktop\n## Setup\nFirst.\n# macOS\n## Setup\nMac.\n# Linux > Desktop\n## Setup\nSecond.\n';
  const f = await fixture({ 'guide.md': source }); t.after(f.cleanup);
  const ambiguous = await f.cli('read-section', 'guide.md', '--title', 'Setup', '--debug');
  assert.equal(ambiguous.code, 1);
  assert.equal(ambiguous.json().error.code, 'ambiguousSection');
  assert.deepEqual(ambiguous.json().error.details, [
    { title: 'Setup', headingPath: ['Linux > Desktop', 'Setup'], id: 'setup' },
    { title: 'Setup', headingPath: ['macOS', 'Setup'] },
    { title: 'Setup', headingPath: ['Linux > Desktop', 'Setup'], id: 'setup-2' },
  ]);
  const plainError = await f.cli('read-section', 'guide.md', '--title', 'Setup');
  assert.equal(plainError.stdout, ''); assert.match(plainError.stderr, /ambiguousSection/);
  assert.equal(plainError.stderr.split('\n').slice(1).join('\n'), '  - Setup (Linux > Desktop > Setup; id: setup)\n  - Setup (macOS > Setup)\n  - Setup (Linux > Desktop > Setup; id: setup-2)\n');
  const mac = await f.cli('read-section', 'guide.md', '--heading-path', '["macOS","Setup"]');
  assert.equal(mac.code, 0); assert.equal(mac.stdout, '## Setup\nMac.\n');
  const repeated = await f.cli('read-section', 'guide.md', '--heading-path', '["Linux > Desktop","Setup"]', '--debug');
  assert.equal(repeated.json().error.code, 'ambiguousSection');
  assert.deepEqual(repeated.json().error.details.map((candidate: any) => candidate.id), ['setup', 'setup-2']);
  assert.equal((await f.cli('read-section', 'guide.md', '--id', 'setup-2')).stdout, '## Setup\nSecond.\n');
  assert.equal((await f.cli('read-section', 'guide.md', '--heading-path', '["Setup"]', '--debug')).json().error.code, 'sectionNotFound');
});

test('glossaries read by owning title or full heading path and retain exact directive source', async t => {
  const first = '(first)=\r\n:::{glossary}\r\nAST\r\n: First definition.\r\n:::\r\n';
  const second = ':::{glossary}\r\nRole\r\n: Second definition.\r\n:::\r\n';
  const f = await fixture({ 'guide.md': `# Linux\r\n## Terms\r\n${first}# macOS\r\n## Terms\r\n${second}`, 'single.md': `# Definitions\r\n${first}` }); t.after(f.cleanup);
  const listed = await f.cli('glossaries', 'guide.md');
  assert.equal(listed.stdout, '- Linux > Terms (guide.md; 1 term)\n- macOS > Terms (guide.md; 1 term)\n');
  const ambiguous = await f.cli('read-glossary', 'guide.md', '--title', 'Terms', '--json');
  assert.equal(ambiguous.code, 1); assert.equal(ambiguous.json().error.code, 'ambiguousGlossary');
  assert.deepEqual(ambiguous.json().error.candidates, [
    { title: 'Terms', headingPath: ['Linux', 'Terms'], file: 'guide.md' },
    { title: 'Terms', headingPath: ['macOS', 'Terms'], file: 'guide.md' },
  ]);
  assert.equal((await f.cli('read-glossary', 'guide.md', '--heading-path', '["Linux","Terms"]')).stdout, first);
  assert.equal((await f.cli('read-glossary', 'single.md', '--title', 'Definitions')).stdout, first);
  const compact = (await f.cli('read-glossary', 'guide.md', '--heading-path', '["macOS","Terms"]', '--json')).json();
  assert.deepEqual(compact, { complete: true, items: [{ kind: 'glossary', file: 'guide.md', content: second }] });
  const missing = await f.cli('read-glossary', 'guide.md', '--title', 'Linux');
  assert.equal(missing.code, 1); assert.equal(missing.stdout, ''); assert.match(missing.stderr, /glossaryNotFound/);
  for (const args of [[], ['guide.md'], ['--title', 'Terms'], ['guide.md', '--title', 'Terms', '--heading-path', '["Linux","Terms"]'],
    ['guide.md', '--id', 'guide.md#glossary-1'], ['guide.md', '--heading-path', '[]']])
    assert.equal((await f.cli('read-glossary', ...args)).code, 2);
});

test('glossaries sharing one heading require listed IDs instead of choosing the first', async t => {
  const first = ':::{glossary}\nAST\n: First.\n:::\n';
  const second = ':::{glossary}\nAPI\n: Second.\n:::\n';
  const f = await fixture({ 'guide.md': `# Terms\n${first}\n${second}` }); t.after(f.cleanup);
  const selected = await f.cli('read-glossary', 'guide.md', '--title', 'Terms', '--json');
  assert.equal(selected.json().error.code, 'ambiguousGlossary');
  assert.deepEqual(selected.json().error.candidates.map((candidate: any) => candidate.id), ['guide.md#glossary-1', 'guide.md#glossary-2']);
  assert.match((await f.cli('glossaries')).stdout, /id: guide.md#glossary-2/);
  assert.equal((await f.cli('read-glossary', '--id', 'guide.md#glossary-2')).stdout, second);
});

test('disk cache reuses parsed records, rebuilds corruption/version changes and updates deletions/assets', async t => {
  const f = await fixture({ 'a.md': '# A\nPrivate body text.\n[[B]] ![asset](a.png)\n', 'b.markdown': '# B\n' }); t.after(f.cleanup);
  await f.index.refresh(); assert.equal(f.index.stats.parsed, 2);
  const stored = await fs.readFile(f.index.cacheFile, 'utf8'); assert.ok(!stored.includes('Private body text.'));
  const second = new MarkdownIndex(f.root, f.cache); await second.refresh(); assert.equal(second.stats.reused, 2);
  assert.equal(second.data.generation, f.index.data.generation);
  await f.write('a.png', 'image'); await second.refresh(); assert.equal(second.document('a.md').images[0].resolution?.status, 'found'); assert.equal(second.stats.parsed, 0);
  const assetSnapshot = JSON.parse(await fs.readFile(second.cacheFile, 'utf8')); assert.equal(assetSnapshot.documents[0].images[0].resolution.status, 'found');
  await fs.unlink(path.join(f.root, 'b.markdown')); await second.refresh(); assert.equal(second.stats.removed, 1); assert.equal(second.document('a.md').outgoing[0].resolution?.status, 'missing');
  await fs.writeFile(second.cacheFile, '{corrupt'); await second.refresh(); assert.equal(second.stats.parsed, 1);
  const wrongVersion = JSON.parse(await fs.readFile(second.cacheFile, 'utf8')); wrongVersion.parserVersion = 'old'; await fs.writeFile(second.cacheFile, JSON.stringify(wrongVersion));
  await second.refresh(); assert.equal(second.stats.parsed, 1);
  await second.refresh(true); assert.equal(second.stats.parsed, 1);
});

test('same-size edits and duplicate term changes refresh hashes and references without reparsing unchanged sources', async t => {
  const f = await fixture({ 'source.md': '{term}`AST`\n', 'a.md': ':::{glossary}\nAST\n: First.\n:::\n', 'b.md': ':::{glossary}\nAST\n: Other.\n:::\n' }); t.after(f.cleanup);
  await f.index.refresh(); assert.equal(f.index.document('source.md').outgoing[0].resolution?.status, 'ambiguous');
  const before = await fs.stat(path.join(f.root, 'b.md'));
  await f.write('b.md', ':::{glossary}\nNEW\n: Other.\n:::\n'); await fs.utimes(path.join(f.root, 'b.md'), before.atime, before.mtime);
  await f.index.refresh(); assert.equal(f.index.stats.parsed, 1); assert.equal(f.index.stats.reused, 2);
  assert.equal(f.index.document('source.md').outgoing[0].resolution?.targetId, 'a.md#term-ast');
  await fs.rename(path.join(f.root, 'a.md'), path.join(f.root, 'renamed.md')); await f.index.refresh();
  assert.equal(f.index.document('source.md').outgoing[0].resolution?.targetId, 'renamed.md#term-ast');
  await fs.unlink(path.join(f.root, 'renamed.md')); await f.index.refresh();
  assert.equal(f.index.document('source.md').outgoing[0].resolution?.status, 'missing');
});

test('separate CLI processes share a cache safely, including concurrent updates and stale locks', async t => {
  const f = await fixture({ 'a.md': '# A\n', 'b.md': '# B\n' }); t.after(f.cleanup);
  const argv = [path.resolve('dist/cli.cjs'), 'index', '--root', f.root, '--cache-dir', f.cache, '--debug'];
  const first = JSON.parse((await execute(process.execPath, argv)).stdout); assert.equal(first.parsed, 2);
  const results = await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath, argv)));
  for (const result of results) { assert.equal(JSON.parse(result.stdout).reused, 2); assert.equal(JSON.parse(result.stdout).generation, first.generation); }
  const lock = path.join(path.dirname(f.index.cacheFile), 'lock'); await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, owner: 'dead-process' }));
  const recovered = await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath, argv)));
  for (const result of recovered) assert.equal(JSON.parse(result.stdout).reused, 2);
  await fs.access(f.index.cacheFile);
});

test('labels include separated label lines; math, empty links and MyST embeds resolve semantic targets', async t => {
  const f = await fixture({
    'a.md': '[](glossary-label) [](#equation) {ref}`image-label`\n\n:::{embed} #glossary-label\n:::\n',
    'b.md': '(glossary-label)=\n\n:::{glossary}\nWord\n: Definition.\n:::\n\n$$\nx=1\n$$ (equation)\n\n(image-label)=\n\n:::{image} asset.png\n:::\n',
    'asset.png': 'image',
  }); t.after(f.cleanup); await f.index.refresh();
  assert.equal(f.index.document('b.md').glossaries[0].startLine, 1);
  assert.equal(f.index.document('b.md').images[0].startLine, 12);
  const refs = f.index.document('a.md').outgoing;
  assert.deepEqual(refs.map(r => r.resolution?.targetKind), ['glossary', 'math', 'image', 'glossary']);
  assert.equal(refs[0].resolution?.targetId, 'b.md#glossary-1');
  assert.equal((await f.cli('read-glossary', '--id', 'b.md#glossary-1')).stdout, '(glossary-label)=\n\n:::{glossary}\nWord\n: Definition.\n:::\n');
  assert.equal((await f.cli('read-section', 'b.md', '--label', 'image-label', '--debug')).json().error.code, 'notASection');
});

test('declared external tables retain metadata without loading data, including unsupported parser declarations', () => {
  const document = parseIndex('a.md', ':::{csv-table} External CSV\n:file: data.csv\n:::\n\n:::{figure} #notebook-table\n:kind: table\n\nTable caption.\n:::\n\n:::{code} md\n:::{table} Not a real table\n:::\n:::\n');
  assert.equal(document.tables.length, 2);
  assert.ok(document.tables.every(table => table.contentStatus === 'referenceOnly' && table.rowCount === null));
  assert.equal(document.tables[1].caption, 'Table caption.');
  assert.equal(document.images.length, 0);
  assert.ok(document.diagnostics.some(d => d.message.includes('csv-table')));
});

test('implicit MyST heading references prefer local targets and exact Markdown fragments select unique section IDs', async t => {
  const f = await fixture({ 'a.md': '# Heading Name\n@heading-name [](heading-name)\n\n## Same\nOne\n## Same\nTwo\n[exact](#same) [[#Same]]\n', 'b.md': '# Heading Name\nOther\n' }); t.after(f.cleanup); await f.index.refresh();
  const refs = f.index.document('a.md').outgoing;
  assert.equal(refs[0].resolution?.file, 'a.md'); assert.equal(refs[1].resolution?.file, 'a.md');
  assert.equal(refs[2].resolution?.targetId, 'same'); assert.equal(refs[2].resolution?.fragmentStatus, 'found');
  assert.equal(refs[3].resolution?.fragmentStatus, 'ambiguous');
  assert.equal((await f.cli('read-section', 'a.md', '--label', 'heading-name', '--debug')).json().section.id, 'heading-name');
});

test('local MyST config and frontmatter overrides invalidate parsing; bibliography citations are excluded', async t => {
  const f = await fixture({ 'myst.yml': 'extends: base.yml\nproject:\n  bibliography: refs.bib\n', 'base.yml': 'project:\n  settings:\n    parser:\n      dollarmath: false\n', 'refs.bib': '@article{known, title={Title}, author={Author}, year={2025}}\n',
    'a.md': '# A\n$[[InMath]]$ @known @unknown\n', 'b.md': '---\nsettings:\n  parser:\n    dollarmath: true\n---\n# B\n$[[InMath]]$\n' }); t.after(f.cleanup);
  await f.index.refresh();
  assert.ok(f.index.document('a.md').outgoing.some(r => r.target === 'InMath'));
  assert.ok(!f.index.document('b.md').outgoing.some(r => r.target === 'InMath'));
  assert.equal(f.index.document('a.md').outgoing.find(r => r.target === 'known')!.resolution!.status, 'citation');
  assert.equal(f.index.document('a.md').outgoing.find(r => r.target === 'unknown')!.resolution!.status, 'missing');
  await f.write('base.yml', 'project:\n  settings:\n    parser:\n      dollarmath: true\n'); await f.index.refresh();
  assert.ok(!f.index.document('a.md').outgoing.some(r => r.target === 'InMath'));
  assert.ok(f.index.stats.parsed > 0);
});

test('excluded paths and symlinks cannot become indexed or readable; invalid documents are partial', async t => {
  const f = await fixture({ 'a.md': '# A\n', '.obsidian/secret.md': '# Secret\n', '.hidden.md': '# Hidden\n', 'node_modules/module.md': '# Module\n', '_build/built.md': '# Build\n', 'bad.md': '---\nduplicate: 1\nduplicate: 2\n---\n# Still parsed\n', 'large.md': 'x'.repeat(2 * 1024 * 1024 + 1) }); t.after(f.cleanup);
  await fs.writeFile(path.join(f.directory, 'outside.md'), '# Outside\n');
  await fs.symlink(path.join(f.directory, 'outside.md'), path.join(f.root, 'link.md'));
  await fs.symlink(f.directory, path.join(f.root, 'linked-dir'));
  const result = await f.cli('notes', '--debug'); assert.equal(result.code, 1); assert.equal(result.json().complete, false);
  assert.deepEqual(result.json().notes.map((n: any) => n.file), ['a.md', 'bad.md', 'large.md']);
  assert.ok(result.json().diagnostics.some((d: any) => d.file === 'large.md'));
  const partialOutline = await f.cli('sections', 'bad.md');
  assert.equal(partialOutline.code, 1); assert.equal(partialOutline.stdout, 'Still parsed\n'); assert.match(partialOutline.stderr, /large.md/);
  assert.equal((await f.cli('sections', 'bad.md', '--debug')).json().sections[0].title, 'Still parsed');
  assert.equal((await f.cli('sections', 'link.md', '--debug')).json().error.code, 'fileNotFound');
});
