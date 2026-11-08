import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fixture } from './helpers';
import { extendMystMarkdown } from '../src/myst';
import { crossReferenceSource, assertCrossReferences } from './cross-references';
import { manualFootnoteSource, mixedFootnoteSource, assertFootnoteNumbers } from './footnote-numbering';
import { glossaryLineBreakSource, assertGlossaryLineBreaks } from './glossary-line-breaks';
import { customTermConfig, customTermSource, termDefSource, assertTermDefPreview } from './term-def';
import { obsidianBlockSource, assertObsidianBlocks } from './obsidian-blocks';
import { findSection } from '../src/references';
import { unifiedPreviewSource, assertUnifiedPreview } from './unified-preview';
import { codeLines } from '../src/code-lines';

const dom = (html: string) => new JSDOM(html).window.document;

test('all Markdown uses MyST and Obsidian syntax composes with directives and roles', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  extendMystMarkdown(f.md, f.host);
  assertUnifiedPreview(dom(f.render(unifiedPreviewSource)));
  const plain = dom(f.render('% hidden\n\n$x$\n\nTerm\n: Definition'));
  assert.ok(plain.querySelector('.katex'));
  assert.equal(plain.querySelector('dd')?.textContent, 'Definition');
  assert.doesNotMatch(plain.body.textContent ?? '', /hidden/);
  assert.equal(dom(f.render('"straight quotes"')).querySelector('p')?.textContent, '"straight quotes"');
  assert.equal(dom(f.render('escaped \\==literal\\== and `==code==`')).querySelector('mark'), null);
  assert.equal(dom(f.render('[local](file:///tmp/note.md)')).querySelector('a')?.getAttribute('href'), 'file:///tmp/note.md');
  assert.equal(dom(f.render('[unsafe](javascript:alert%281%29)')).querySelector('a'), null);
  f.md.options.breaks = true;
  assert.ok(dom(f.render('First\nSecond')).querySelector('p br'));
});

test('highlighted spans remain balanced across numbered code lines', () => {
  assert.deepEqual(codeLines('a<span class="s">"x\n<span class="inner">y</span>"</span>b'), ['a<span class="s">"x</span>', '<span class="s"><span class="inner">y</span>"</span>b']);
});

test('unified notebook Markdown renders MyST and stops recursive notebook embeds', async t => {
  const notebook = (source: string) => JSON.stringify({ cells: [{ cell_type: 'markdown', source }], metadata: {} });
  const f = await fixture(t, { 'Main.md': '', 'book.ipynb': notebook('Standalone $x$\n\n:::{embed} book.ipynb\n:::') });
  extendMystMarkdown(f.md, f.host);
  const document = dom(f.render(':::{embed} book.ipynb\n:::'));
  assert.ok(document.querySelector('.katex'));
  assert.match(document.body.textContent ?? '', /Cyclic or deeply nested notebook embed stopped/);
});

test('headings containing wikilinks retain their visible text as the anchor', async t => {
  const source = '# [[Note|Visible name]]\n\n[[#Visible name]]';
  const f = await fixture(t, { 'Main.md': source, 'Note.md': 'Note' });
  extendMystMarkdown(f.md, f.host);
  const document = dom(f.render(source));
  assert.ok(document.getElementById('visible-name'));
  assert.ok(document.querySelector('a[href="#visible-name"]'));
});

test('footnote bodies use the same MyST directive and Obsidian syntax pipeline', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  extendMystMarkdown(f.md, f.host);
  const document = dom(f.render('A[^n]\n\n[^n]: :::{note}\n    ==**Nested** {kbd}`Ctrl`==\n    :::'));
  assert.equal(document.querySelector('.footnote-item .myst-admonition mark strong')?.textContent, 'Nested');
  assert.equal(document.querySelector('.footnote-item kbd')?.textContent, 'Ctrl');
  assert.equal(document.querySelectorAll('.footnote-item').length, 1);
});

test('Obsidian block anchors and wikilinks survive MyST roles and project configuration', async t => {
  for (const [prefix, configuration] of [['', false], ['{kbd}`Ctrl`\n\n', false], ['', true]] as const) {
    const source = prefix + obsidianBlockSource;
    const f = await fixture(t, { 'Main.md': source, ...(configuration ? { 'myst.yml': 'version: 1\nproject: {}\n' } : {}) });
    extendMystMarkdown(f.md, f.host);
    assertObsidianBlocks(dom(f.render(source)));
    const section = findSection(f.md, source, '^item');
    assert.ok(section);
    assert.equal(source.split('\n').slice(section.start, section.end).join('\n').trim(), '- src/lib/ ^item');
    for (const id of ['fake', 'inline', 'escaped']) assert.equal(findSection(f.md, source, `^${id}`), undefined);
  }
});

test('MyST block links and embeds select saved or dirty list items and prefix embedded anchors', async t => {
  const source = '{kbd}`Ctrl`\n\n' + obsidianBlockSource;
  const f = await fixture(t, { 'Main.md': '', 'Note.md': source });
  extendMystMarkdown(f.md, f.host);
  for (const prefix of ['', '{kbd}`Ctrl`\n\n']) {
    const document = dom(f.render(prefix + '[[Note#^item]]\n\n![[Note#^item]]\n\n![[Note#^list]]'));
    assert.equal(document.querySelector('a.obsidian-link')?.getAttribute('href'), 'Note.md#obsidian-block-item');
    const embeds = [...document.querySelectorAll('.obsidian-embed-content')];
    assert.equal(embeds[0].querySelectorAll('li').length, 1);
    assert.equal(embeds[0].querySelector('li')?.textContent?.trim(), 'src/lib/');
    assert.equal(embeds[1].querySelectorAll('li').length, 2);
    assert.equal(document.querySelector('#obsidian-block-item'), null);
    assert.equal(new Set([...document.querySelectorAll('[id]')].map(node => node.id)).size, document.querySelectorAll('[id]').length);
    assert.equal(document.querySelector('.is-unresolved, .obsidian-embed-error'), null);
  }
  const tokens = f.md.parse('{kbd}`Ctrl`\n\n![[Note#^item]]', f.environment());
  f.dirty.set(`${f.root}/Note.md`, source.replace('src/lib/', 'src/changed/'));
  const document = dom(f.md.renderer.render(tokens, f.md.options, f.environment()));
  assert.match(document.querySelector('.obsidian-embed-content')?.textContent ?? '', /src\/changed\//);
});

test('MyST block discovery preserves heading labels and excludes colon-fenced code targets', async t => {
  const source = '{kbd}`Ctrl`\n\n(label)=\n## Heading ^heading\n\n[[#^heading]] {ref}`label`\n\n:::{code} md\n## Fake heading\n\nFake paragraph. ^fake\n\n:::\n';
  const f = await fixture(t, { 'Main.md': source });
  extendMystMarkdown(f.md, f.host);
  const document = dom(f.render(source));
  for (const link of document.querySelectorAll('a')) assert.ok(document.getElementById(link.getAttribute('href')!.slice(1)), link.outerHTML);
  assert.equal(document.querySelectorAll('a.obsidian-link').length, 1);
  assert.equal(findSection(f.md, source, '^fake'), undefined);
  assert.equal(findSection(f.md, source, 'Fake heading'), undefined);
  assert.equal(document.getElementById('obsidian-block-fake'), null);
  assert.match(document.querySelector('pre code')?.textContent ?? '', /Fake paragraph\. \^fake/);
});

test('indented glossary definitions render canonical terms, aliases and references without changing ordinary prose', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  extendMystMarkdown(f.md, f.host);
  for (const source of [glossaryLineBreakSource, glossaryLineBreakSource.replace(/\n/g, '\r\n')]) {
    assertGlossaryLineBreaks(dom(f.render(source)));
  }
});

test('glossary alias collisions remain unresolved in preview', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  extendMystMarkdown(f.md, f.host);
  const doc = dom(f.render(':::{glossary}\nfirst\nShared name\n\n   First definition.\n\nsecond\nShared name\n\n   Second definition.\n:::\n\n{term}`Shared name`'));
  assert.equal(doc.querySelectorAll('dt').length, 2);
  assert.equal(doc.querySelector('a[href="#term-first"], a[href="#term-second"]'), null);
  assert.equal(doc.querySelector('.myst-unresolved')?.textContent, 'Shared name');
});

test('term-def renders Markdown and localized folded metadata, with local and cross-file term references', async t => {
  const f = await fixture(t, { 'Main.md': '', 'definitions.md': termDefSource });
  f.host.language = 'ko';
  extendMystMarkdown(f.md, f.host);
  assertTermDefPreview(dom(f.render(termDefSource, 'definitions.md')), 'ko');
  const references = '{term}`Store worker` {term}`Cache handler` {term}`캐시 작업자` {term}`Legacy`';
  const external = dom(f.render(references));
  assert.deepEqual([...external.querySelectorAll('a')].map(link => link.getAttribute('href')),
    ['definitions.md#term-cache-worker', 'definitions.md#term-cache-worker', 'definitions.md#term-cache-worker', 'definitions.md#term-legacy']);
  await fs.writeFile(path.join(f.root, 'other.md'), ':::{term-def} Store worker\nAn unrelated definition.\n:::');
  await f.vault.refresh();
  assert.equal(dom(f.render(references)).querySelector('.myst-unresolved')?.textContent, 'Store worker');
});

test('project term mappings drive native preview and its static cross-file inventory', async t => {
  const f = await fixture(t, { 'Main.md': '', 'kb/terms.md': customTermSource, 'kb/myst.yml': customTermConfig });
  extendMystMarkdown(f.md, f.host);
  const rendered = dom(f.render(customTermSource, 'kb/terms.md'));
  assert.equal(rendered.querySelector('.myst-term-definition > dt')?.textContent, 'Cache worker');
  assert.equal(rendered.querySelector('.myst-term-fields > dd')?.textContent, 'Cache handler');
  const reference = '{term}`Store worker`';
  assert.equal(dom(f.render(reference)).querySelector('a')?.getAttribute('href'), 'kb/terms.md#term-cache-worker');
  assert.ok(dom(f.render(customTermSource)).querySelector('.myst-error'));
  await fs.writeFile(path.join(f.root, 'kb/myst.yml'), customTermConfig.replace('previous', 'retired'));
  await f.vault.refresh();
  assert.ok(dom(f.render(reference)).querySelector('.myst-unresolved'));
});

test('manual footnote numbers and bracketed references match MyST in both rendering paths', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  extendMystMarkdown(f.md, f.host);
  for (const prefix of ['', '{kbd}`Ctrl`\n\n']) {
    assertFootnoteNumbers(dom(f.render(prefix + manualFootnoteSource)), ['1', '3']);
    assertFootnoteNumbers(dom(f.render(prefix + mixedFootnoteSource)), ['2', '4', '1', '5', '3', '2']);
  }
});

test('cross-reference guide syntax renders names, numbers, formatting and existing anchors', async t => {
  const f = await fixture(t, { 'Main.md': '', 'assets/preview.svg': '<svg/>' });
  extendMystMarkdown(f.md, f.host);
  assertCrossReferences(dom(f.render(crossReferenceSource)));
});

test('implicit heading references activate MyST without a project or directive', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  extendMystMarkdown(f.md, f.host);
  for (const reference of ['@a-heading', '[](#a-heading)']) {
    const doc = dom(f.render(`## A heading\n\n${reference}`));
    assert.equal(doc.querySelector('a[href="#a-heading"]')?.textContent, 'A heading');
    assert.ok(doc.getElementById('a-heading'));
  }
});

test('ref roles preserve Korean display text for local and cross-file section labels', async t => {
  const local = '(ny2027-section-7)=\n## 공통 수단\n\n';
  const links = '{ref}`두 시나리오에 공통인 기능별 수단 <ny2027-section-7>`에서 조치를 찾고, {ref}`코드 근거 <ny2027-direct-relay-section-8>`';
  const f = await fixture(t, {
    'Main.md': local + links,
    'relay/Direct relay.md': '(ny2027-direct-relay-section-8)=\n## 코드 근거\n',
    'duplicate.md': local,
    'another-duplicate.md': local,
  });
  extendMystMarkdown(f.md, f.host);
  const doc = dom(f.render(local + links));
  assert.equal(doc.querySelector('a[href="#ny2027-section-7"]')?.textContent, '두 시나리오에 공통인 기능별 수단');
  const remoteHref = `relay/Direct%20relay.md#${encodeURIComponent('코드-근거')}`;
  const remote = doc.querySelector(`a[href="${remoteHref}"]`);
  assert.equal(remote?.textContent, '코드 근거');
  assert.equal(remote?.getAttribute('data-href'), remote?.getAttribute('href'));
  assert.equal(doc.querySelector('.myst-unresolved'), null);
  const destination = dom(f.render('(ny2027-direct-relay-section-8)=\n## 코드 근거', 'relay/Direct relay.md'));
  assert.ok(destination.getElementById('ny2027-direct-relay-section-8'));
  assert.ok(destination.getElementById(encodeURIComponent('코드-근거'))?.classList.contains('code-line'));
  assert.equal(dom(f.render('{ref}`ny2027-section-7`')).querySelector('a'), null, 'Duplicate external labels remain unresolved');

  const tokens = f.md.parse(links, f.environment());
  f.dirty.set(`${f.root}/relay/Direct relay.md`, '(changed-label)=\n## Unsaved\n');
  const changed = dom(f.md.renderer.render(tokens, f.md.options, f.environment()));
  assert.equal(changed.querySelector(`a[href="${remoteHref}"]`), null, 'Cached targets refresh from dirty buffers');
});

test('external refs use the label index beyond 100 documents and 4 MiB of unrelated Markdown', async t => {
  const filler = '```text\n' + 'Unrelated prose.\n'.repeat(2500) + '```\n';
  const files = Object.fromEntries(Array.from({ length: 110 }, (_, index) => [`filler/${index}.md`, filler]));
  const f = await fixture(t, { 'Main.md': '', ...files, 'z/Target.md': '(remote-label)=\n## Remote section\n' });
  const read = f.host.read;
  const markdownReads: string[] = [];
  f.host.read = file => { if (file.endsWith('.md')) markdownReads.push(file); return read(file); };
  extendMystMarkdown(f.md, f.host);
  const doc = dom(f.render('{ref}`Evidence <remote-label>`'));
  assert.equal(doc.querySelector('a')?.getAttribute('href'), 'z/Target.md#remote-section');
  assert.equal(doc.querySelector('.myst-unresolved'), null);
  assert.ok(markdownReads.length > 0);
  assert.ok(markdownReads.every(file => file === `${f.root}/z/Target.md`), 'Only matching target documents consume render reads');
});

test('external ref targets respect explicit paths, source context and root boundaries', async t => {
  const f = await fixture(t, {
    'Main.md': '',
    'sub/Source.md': '',
    'sub/Target.md': '(section)=\n## Target section\n',
    'Other.md': '(section)=\n## Duplicate section\n',
    'Code.md': '```md\n(fake-label)=\n## Fake\n```',
  });
  extendMystMarkdown(f.md, f.host);
  const doc = dom(f.render('{ref}`Section <Target.md#section>`', 'sub/Source.md'));
  assert.equal(doc.querySelector('a')?.getAttribute('href'), 'Target.md#target-section');
  const explicit = dom(f.render('(section)=\n## Local\n\n[제목](Target.md#section)', 'sub/Source.md'));
  assert.equal(explicit.querySelector('a')?.getAttribute('href'), 'Target.md#target-section', 'An explicit file wins over a matching local or global label');
  for (const label of ['../outside.md#section', 'fake-label', 'missing-label']) {
    assert.equal(dom(f.render(`{ref}\`${label}\``)).querySelector('a'), null);
  }
});

test('section headings expose native navigation positions without mapping embedded source lines', async t => {
  const source = '---\ntitle: Source\n---\n\n(label)=\n## Section\n';
  const f = await fixture(t, { 'Main.md': source, 'Target.md': source });
  extendMystMarkdown(f.md, f.host);
  const heading = dom(f.render(source)).querySelector('h2#label');
  assert.ok(heading?.classList.contains('code-line'));
  assert.equal(heading?.getAttribute('data-line'), '5');
  const outline = f.md.parse(source, f.environment()).filter(token => token.meta?.mystOutline);
  assert.deepEqual(outline.map(token => token.type), ['heading_open', 'inline', 'heading_close']);
  assert.equal(outline[1].content, 'Section');
  assert.equal(dom(f.render(source)).querySelectorAll('h2').length, 1, 'Native outline tokens do not render twice');
  for (const embedded of ['![[Target]]', ':::{include} Target.md\n:::']) {
    const doc = dom(f.render(embedded));
    assert.ok(doc.querySelector('h2'));
    assert.equal(doc.querySelector('h2.code-line, h2[data-line]'), null);
  }
});

test('dotted prose stays literal while explicit URLs, Markdown links and emails remain linked', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  extendMystMarkdown(f.md, f.host);
  for (const source of ['malang.cow / remi.ni', ':::{note}\nmalang.cow / remi.ni\n:::', '`malang.cow / remi.ni`']) {
    const doc = dom(f.render(source));
    assert.equal(doc.querySelector('a'), null);
    assert.match(doc.body.textContent ?? '', /malang\.cow \/ remi\.ni/);
  }
  const doc = dom(f.render('https://example.com <https://remi.ni> [Profile](https://remi.ni) author@example.com'));
  assert.deepEqual([...doc.querySelectorAll('a')].map(link => link.getAttribute('href')), ['https://example.com', 'https://remi.ni', 'https://remi.ni', 'mailto:author@example.com']);
});

test('official MyST directives and roles render in a standalone Markdown file', async t => {
  const f = await fixture(t, { 'Main.md': '', 'Note.md': 'linked' });
  extendMystMarkdown(f.md, f.host);
  const doc = dom(f.render('::: {note}\n---\nlabel: sample\nclass: dropdown\n---\n**본문**과 [[Note]]\n:::\n\n{span #span .font-semibold}`내용` H{sub}`2`O\n\n```{math}\n:label: eq\na^2+b^2=c^2\n```\n\n{eq}`eq`'));
  assert.ok(doc.querySelector('details#sample strong'));
  assert.equal(doc.querySelector('a.obsidian-link')?.textContent, 'Note');
  assert.equal(doc.querySelector('#span')?.textContent, '내용');
  assert.equal(doc.querySelector('sub')?.textContent, '2');
  assert.ok(doc.querySelector('.katex'));
  assert.ok(doc.querySelector('a[href="#eq"]'));
  assert.doesNotMatch(doc.body.textContent ?? '', /:::\{|:label:|:class:|\{note\}/);
});

test('all authoring demos render without a myst.yml or server', async t => {
  const files = Object.fromEntries(['index.md', 'layout.md', 'syntax.md', 'included.md', 'references.bib', 'notebook.ipynb', 'assets/preview.svg', 'assets/sample.mp4'].map(name => [name, readFileSync(`examples/myst/${name}`, 'utf8')]));
  const f = await fixture(t, { ...files, 'Main.md': '' });
  extendMystMarkdown(f.md, f.host);
  for (const name of ['index', 'layout', 'syntax']) {
    const env = { ...f.environment(`${name}.md`), slugifier: { add: (value: string) => ({ value }) } };
    const doc = dom(f.md.render(files[`${name}.md`], env));
    assert.doesNotMatch(doc.body.textContent ?? '', /Unsupported or invalid|:::\{|:label:|:class:/, name);
    if (name === 'index') {
      assert.ok(doc.querySelector('.myst-tabs [role="tab"]'));
      assert.ok(doc.querySelector('.myst-grid .myst-card'));
      assert.ok(doc.querySelector('#sum-theorem'));
      assert.match(doc.body.textContent ?? '', /notebook output: 42/i);
      assert.match(doc.body.textContent ?? '', /include directive/);
      assert.match(doc.querySelector('.myst-bibliography')?.textContent ?? '', /Literate Programming/);
    } else if (name === 'layout') {
      assert.equal(doc.querySelectorAll('.myst-aside').length, 4);
      assert.ok(doc.querySelector('figure figcaption strong'));
      assert.ok(doc.querySelector('video[controls]'));
      assert.ok(doc.querySelector('img[style*="width:160px"]'));
    } else {
      assert.ok(doc.querySelector('details#yaml-options-note'));
      assert.ok(doc.querySelector('details#inline-options-tip'));
      assert.ok(doc.querySelector('a[href="#term-myst-preview"]'));
      assert.ok(doc.querySelector('.myst-mermaid'));
    }
  }
});

test('MyST code examples stay literal and Obsidian remains compatible', async t => {
  const f = await fixture(t, { 'Main.md': '', 'Note.md': '# Note\n\nNote content' });
  extendMystMarkdown(f.md, f.host);
  const doc = dom(f.render('```md\n:::{note}\n:label: literal\nbody\n:::\n```\n\n{kbd}`Ctrl`\n\n> [!tip]- 제목\n> 본문\n\n==강조== [[Note]]\n\n[^one]\n\n[^one]: Footnote **content**'));
  assert.match(doc.querySelector('pre code')?.textContent ?? '', /:::\{note\}/);
  assert.ok(doc.querySelector('details.obsidian-callout'));
  assert.equal(doc.querySelector('mark')?.textContent, '강조');
  assert.ok(doc.querySelector('a.obsidian-link'));
  assert.ok(doc.querySelector('.obsidian-footnotes strong'));
  assert.doesNotMatch(doc.body.textContent ?? '', /↑/);
});

test('cached MyST includes read dirty buffers and block unsafe or cyclic sources', async t => {
  const f = await fixture(t, { 'Main.md': '', 'part.md': 'Original', 'cycle.md': '```{include} cycle.md\n```' });
  extendMystMarkdown(f.md, f.host);
  const tokens = f.md.parse('```{include} part.md\n```', f.environment());
  f.dirty.set(`${f.root}/part.md`, '**Unsaved**');
  assert.match(f.md.renderer.render(tokens, f.md.options, f.environment()), /<strong>Unsaved<\/strong>/);
  const doc = dom(f.render('```{include} cycle.md\n```\n\n```{include} ../outside.md\n```\n\n```{image} javascript:alert(1)\n```'));
  assert.equal(doc.querySelectorAll('.myst-error').length, 2);
  assert.equal(doc.querySelector('img')?.getAttribute('src'), '');
});

test('optional myst.yml applies inherited defaults, relative bibliography and page overrides', async t => {
  const f = await fixture(t, {
    'base.yml': "project:\n  math:\n    '\\RR': '\\mathbb{R}'\n  numbering:\n    figure: false\n",
    'myst.yml': 'version: 1\nextends: base.yml\nproject:\n  bibliography: references.bib\n  abbreviations:\n    AST: Abstract Syntax Tree\n  settings:\n    parser:\n      dollarmath: false\n',
    'references.bib': readFileSync('examples/myst/references.bib', 'utf8'),
    'nested/Main.md': '', 'nested/image.svg': '<svg/>',
  });
  extendMystMarkdown(f.md, f.host);
  const source = 'AST $x$ {math}`\\RR`\n\n```{figure} image.svg\n:label: fig\nCaption\n```\n\n{cite:p}`knuth1984`\n\n```{bibliography}\n```';
  const doc = dom(f.render(source, 'nested/Main.md'));
  assert.match(doc.body.textContent ?? '', /\$x\$/);
  assert.ok(doc.querySelector('abbr[title="Abstract Syntax Tree"]'));
  assert.equal(doc.querySelectorAll('.katex').length, 1);
  assert.equal(doc.querySelector('.katex-error'), null);
  assert.equal(doc.querySelector('.myst-caption-number'), null);
  assert.match(doc.querySelector('.myst-bibliography')?.textContent ?? '', /Literate Programming/);
  const override = dom(f.render('---\nnumbering:\n  figure: true\n---\n\n' + source, 'nested/Main.md'));
  assert.ok(override.querySelector('.myst-caption-number'));
  f.dirty.set(`${f.root}/myst.yml`, 'version: 1\nproject:\n  settings:\n    parser:\n      dollarmath: true\n');
  assert.equal(dom(f.render(source, 'nested/Main.md')).querySelectorAll('.katex').length, 2);
});

test('invalid or cyclic optional configuration reports a readable error and renders the document', async t => {
  const f = await fixture(t, { 'Main.md': '', 'myst.yml': 'extends: myst.yml\nproject: {}' });
  extendMystMarkdown(f.md, f.host);
  const source = ':::{note}\nText **Body**\n:::';
  let doc = dom(f.render(source));
  assert.match(doc.querySelector('.myst-error')?.textContent ?? '', /Cyclic/);
  assert.equal(doc.querySelector('strong')?.textContent, 'Body');
  f.dirty.set(`${f.root}/myst.yml`, 'project: [broken');
  doc = dom(f.render(source));
  assert.ok(doc.querySelector('.myst-error'));
  assert.equal(doc.querySelector('strong')?.textContent, 'Body');
});


test('MyST footnotes link to every reference in reference order without tooltips', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  extendMystMarkdown(f.md, f.host);
  const doc = dom(f.render('---\ntitle: Sample\n---\n\n{kbd}`Ctrl`\n\nFirst[^n] and again[^n].\n\nSecond[^n] with **bold**.\n\n[^n]: Definition.'));
  const links = [...doc.querySelectorAll('.obsidian-footnote-backref')];
  assert.deepEqual(links.map(link => link.textContent), ['↩₁', '↩₂', '↩₃']);
  assert.ok(links.every(link => !link.hasAttribute('title')));
  assert.equal(new Set(links.map(link => link.getAttribute('href'))).size, 3);
  for (const link of links) assert.ok(doc.getElementById(link.getAttribute('href')!.slice(1)));
});

test('cross-file links, shorthand and document links follow the MyST cross-reference guide', async t => {
  const target = '---\ntitle: Other Title\n---\n\n(oth-sec)=\n## Other Section\n\n```{figure} x.png\n:label: oth-fig\nCap\n```\n\n```{math}\n:label: oth-eq\nx=1\n```\n\n## Plain Heading\n';
  const f = await fixture(t, {
    'Main.md': '', 'other.md': target, 'sub/deep.md': '# Deep doc\n', 'sub/untitled.md': 'Text\n',
    'refs.bib': '@article{smith2020, author={Smith, J}, title={T}, year={2020}}',
  });
  extendMystMarkdown(f.md, f.host);
  const link = (source: string) => { const a = dom(f.render(source)).querySelector('a'); return [a?.getAttribute('href'), a?.textContent?.replace(/\s+/g, ' ')]; };
  assert.deepEqual(link('[](./other.md)'), ['other.md', 'Other Title']);
  assert.deepEqual(link('{doc}`other`'), ['other.md', 'Other Title']);
  assert.deepEqual(link('[](sub/deep.md)'), ['sub/deep.md', 'Deep doc']);
  assert.deepEqual(link('[](sub/untitled.md)'), ['sub/untitled.md', 'untitled']);
  assert.deepEqual(link('[text](./other.md)'), ['other.md', 'text']);
  assert.deepEqual(link('{download}`other.md`'), ['other.md', 'other.md']);
  assert.deepEqual(link('[](./other.md#oth-fig)'), ['other.md#oth-fig', 'Figure 1']);
  assert.deepEqual(link('[](./other.md#plain-heading)'), ['other.md#plain-heading', 'Plain Heading']);
  assert.deepEqual(link('[](#oth-fig)'), ['other.md#oth-fig', 'Figure 1']);
  assert.deepEqual(link('[Equation %s](#oth-eq)'), ['other.md#oth-eq', 'Equation 1']);
  assert.deepEqual(link('@oth-sec.'), ['other.md#other-section', 'Other Section']);
  assert.deepEqual(link('@oth-eq'), ['other.md#oth-eq', '(1)']);
  // As in the project index, a unique implicit heading resolves; citations keep priority.
  assert.deepEqual(link('[](#plain-heading)'), ['other.md#plain-heading', 'Plain Heading']);
  assert.deepEqual(link('[](#unknown-label)'), ['#unknown-label', '#unknown-label']);
  await fs.writeFile(path.join(f.root, 'labeled.md'), '(plain-heading)=\nLabeled paragraph.\n');
  await f.vault.refresh();
  assert.equal(link('[](#plain-heading)')[0], 'labeled.md#plain-heading', 'Explicit labels win over heading slugs');
  const cited = dom(f.render('---\nbibliography: refs.bib\n---\n@smith2020 and @oth-fig'));
  assert.equal(cited.querySelector('.myst-citation')?.textContent, 'Smith, 2020');
  assert.equal(cited.querySelector('a[href="other.md#oth-fig"]')?.textContent?.replace(/\s+/g, ' '), 'Figure 1');
  // VS Code scrolls to a cross-document fragment through code-line elements.
  const destination = dom(f.render(target, 'other.md'));
  for (const id of ['oth-fig', 'oth-eq']) {
    const element = destination.getElementById(id);
    assert.ok(element?.classList.contains('code-line'), id);
    assert.ok(element?.getAttribute('data-line'), id);
  }
  const included = dom(f.render(':::{include} other.md\n:::'));
  assert.equal(included.querySelector('#oth-fig.code-line, #oth-eq[data-line]'), null);
});
