import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers';
import { extendMystMarkdown } from '../src/myst';
import { crossReferenceSource, assertCrossReferences } from './cross-references';

const dom = (html: string) => new JSDOM(html).window.document;

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
  assert.doesNotMatch(doc.body.textContent ?? '', /↩/);
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


test('MyST footnotes link to every reference in reference order and sentence tooltips', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  extendMystMarkdown(f.md, f.host);
  const doc = dom(f.render('---\ntitle: Sample\n---\n\n{kbd}`Ctrl`\n\nFirst[^n] and again[^n].\n\nSecond[^n] with **bold**.\n\n[^n]: Definition.'));
  const links = [...doc.querySelectorAll('.obsidian-footnote-backref')];
  assert.deepEqual(links.map(link => link.textContent), ['↑1', '↑2', '↑3']);
  assert.equal(links[2].getAttribute('title'), 'Second with bold.');
  assert.equal(new Set(links.map(link => link.getAttribute('href'))).size, 3);
  for (const link of links) assert.ok(doc.getElementById(link.getAttribute('href')!.slice(1)));
});
