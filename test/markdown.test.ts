import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import MarkdownIt from 'markdown-it';
import { fixture } from './helpers';
import { extendObsidianMarkdown } from '../src/markdown';
import { findSection, parseWiki } from '../src/references';

const dom = (html: string) => new JSDOM(html).window.document;

test('wiki links resolve late, include aliases and escape display text', async t => {
  const f = await fixture(t, { 'Main.md': '', 'folder/한글 노트.md': '---\naliases: [별칭]\n---\n# Hello *world*\n' });
  const tokens = f.md.parse('[[folder/한글 노트#Hello world|<b>표시</b>]] [[별칭]]', {});
  const doc = dom(f.md.renderer.render(tokens, f.md.options, f.environment()));
  const links = [...doc.querySelectorAll('a')];
  assert.equal(links.length, 2);
  assert.equal(links[0].textContent, '<b>표시</b>');
  assert.equal(links[0].querySelector('b'), null);
  assert.match(links[0].href, /%ED%95%9C%EA%B8%80%20%EB%85%B8%ED%8A%B8\.md#hello-world$/);
  assert.equal(links[0].getAttribute('data-href'), links[0].getAttribute('href'));
});

test('wiki links take precedence over keyboard markup in either extension registration order', async t => {
  const f = await fixture(t, { 'Main.md': '- [ ] Task\n\n^checklist', 'notes/Linked note.md': '# Implementation\n\nBody' });
  // Markdown Extended registers its [[keyboard]] tokenizer before `link`.
  const keyboard = (md: MarkdownIt) => md.inline.ruler.before('link', 'kbd', (state, silent) => {
    const match = /^\[\[([^\]\n]+)\]\]/.exec(state.src.slice(state.pos));
    if (silent || !match) return false;
    state.push('kbd_open', 'kbd', 1);
    state.push('text', '', 0).content = match[1];
    state.push('kbd_close', 'kbd', -1);
    state.pos += match[0].length;
    return true;
  });
  for (const order of ['before', 'after']) {
    const md = new MarkdownIt();
    if (order === 'before') keyboard(md);
    extendObsidianMarkdown(md, f.host);
    if (order === 'after') keyboard(md);
    const doc = dom(md.render('[[notes/Linked note|연결된 노트]] · [[notes/Linked note#Implementation|제목 링크]] · [[#^checklist|블록 링크]]\n\n`[[notes/Linked note]]`\n\n\\[[notes/Linked note]]', f.environment()));
    const links = [...doc.querySelectorAll('a.obsidian-link')];
    assert.deepEqual(links.map(link => link.textContent), ['연결된 노트', '제목 링크', '블록 링크'], order);
    assert.deepEqual(links.map(link => link.getAttribute('href')), ['notes/Linked%20note.md', 'notes/Linked%20note.md#implementation', '#obsidian-block-checklist'], order);
    assert.equal(doc.querySelector('kbd'), null, order);
    assert.equal(doc.querySelector('code')?.textContent, '[[notes/Linked note]]', order);
    assert.match(doc.body.textContent ?? '', /\[\[notes\/Linked note\]\]/);
  }
});

test('cached wiki tokens use each rendering document, rather than the active editor', async t => {
  const f = await fixture(t, { 'a/Main.md': '', 'a/Note.md': 'A', 'b/Main.md': '', 'b/Note.md': 'B' });
  const tokens = f.md.parse('[[Note]]', {});
  const a = f.md.renderer.render(tokens, f.md.options, f.environment('a/Main.md'));
  const b = f.md.renderer.render(tokens, f.md.options, f.environment('b/Main.md'));
  assert.match(a, /data-href="Note\.md"/);
  assert.match(b, /data-href="Note\.md"/);
  const embeds = f.md.parse('![[Note]]', {});
  assert.match(f.md.renderer.render(embeds, f.md.options, f.environment('a/Main.md')), /<p>A<\/p>/);
  assert.match(f.md.renderer.render(embeds, f.md.options, f.environment('b/Main.md')), /<p>B<\/p>/);
});

test('untitled notes render formatting without trying to resolve a local vault', async t => {
  const f = await fixture(t, { 'Main.md': '', 'Note.md': '' });
  const env = { currentDocument: { fsPath: path.join(f.root, 'Main.md'), scheme: 'untitled' } };
  const doc = dom(f.md.render('==formatting== [[Note]]', env));
  assert.equal(doc.querySelector('mark')?.textContent, 'formatting');
  assert.ok(doc.querySelector('.is-unresolved'));
  assert.equal(doc.querySelector('a'), null);
});

test('missing, ambiguous and out-of-vault links are visibly unresolved', async t => {
  const f = await fixture(t, { 'Main.md': '', 'a/Note.md': '', 'b/Note.md': '' });
  const doc = dom(f.render('[[Missing]] [[Note]] [[../outside]] [[https://example.com]]'));
  assert.equal(doc.querySelectorAll('.is-unresolved').length, 4);
  assert.equal(doc.querySelectorAll('a').length, 0);
  assert.match(doc.body.textContent ?? '', /Missing/);
});

test('inline/fenced/indented code and escaped syntax are preserved', async t => {
  const f = await fixture(t, { 'Main.md': '', 'Note.md': '' });
  const source = '`[[Note]] ==mark== %%comment%%`\n\n```md\n![[Note]]\n> [!tip] title\n%%comment%%\n```\n\n    [[Note]]\n\n\\[[Note]]';
  const doc = dom(f.render(source));
  assert.equal(doc.querySelectorAll('.obsidian-link, .obsidian-callout, mark').length, 0);
  assert.match(doc.querySelector('code')?.textContent ?? '', /%%comment%%/);
});

test('comments spanning blank lines are removed without swallowing following content', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  const doc = dom(f.render('before %%inline%% after\n\n%%\nhidden\n\n# Hidden heading\n%%\n\nVisible'));
  assert.equal(doc.querySelector('h1'), null);
  assert.equal(doc.body.textContent?.trim(), 'before  after\nVisible');
});

test('nested callouts have Markdown titles and correct folding defaults', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  const doc = dom(f.render('> [!WARNING]- **주의**\n> body\n>\n> > [!tip]+ 내부\n> > nested\n\n> [!custom] Title only'));
  const details = [...doc.querySelectorAll('details')];
  assert.equal(details.length, 2);
  assert.equal(details[0].open, false);
  assert.equal(details[1].open, true);
  assert.equal(details[0].dataset.calloutStyle, 'warning');
  assert.equal(details[0].querySelector('summary strong')?.textContent, '주의');
  for (const callout of details) {
    const title = callout.querySelector('summary')!;
    assert.equal(title.lastElementChild?.getAttribute('class'), 'obsidian-callout-fold');
    assert.equal(title.lastElementChild?.getAttribute('aria-hidden'), 'true');
  }
  assert.equal(doc.querySelector('[data-callout="custom"]')?.getAttribute('data-callout-style'), 'note');
  assert.equal(doc.querySelector('[data-callout="custom"] .obsidian-callout-fold'), null);
  assert.match(doc.body.textContent ?? '', /body/);
  assert.match(doc.body.textContent ?? '', /nested/);
});

test('highlight colors, tags and nonstandard completed tasks render', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  const doc = dom(f.render('==highlight== ==🔴red== #한글/개발 #1984\n\n- [ ] todo\n- [?] done\n- [-] done\n- [x] done'));
  assert.equal(doc.querySelectorAll('mark').length, 2);
  assert.equal(doc.querySelector('mark[data-highlight="red"]')?.textContent, 'red');
  assert.equal(doc.querySelectorAll('.obsidian-tag').length, 1);
  const tasks = [...doc.querySelectorAll<HTMLInputElement>('input')];
  assert.deepEqual(tasks.map(task => task.checked), [false, true, true, true]);
  assert.ok(tasks.every(task => task.disabled));
});

test('reference footnotes and inline footnotes are rendered together', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  const doc = dom(f.render('Reference[^n], inline ^[inline text].\n\n[^n]: Note with **bold**.'));
  assert.equal(doc.querySelectorAll('.footnote-item').length, 2);
  assert.equal(doc.querySelector('.footnote-item strong')?.textContent, 'bold');
  assert.match(doc.body.textContent ?? '', /inline text/);
  assert.equal(doc.querySelectorAll('.obsidian-footnotes').length, 1);
  assert.equal(doc.querySelector('.obsidian-footnote-number')?.tagName, 'SPAN');
  assert.equal(doc.querySelector('.obsidian-footnote-backref')?.getAttribute('href'), '#fnref1');
  assert.equal(doc.querySelector('.obsidian-footnote-backref')?.textContent, '↑1');
  assert.equal(doc.querySelector('.footnote-backref'), null);
  assert.doesNotMatch(doc.body.textContent ?? '', /↩/);
});

test('footnotes support repeated references, multiline definitions and forward references within notes', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  const doc = dom(f.render('First[^named], again[^named], missing[^unknown].\n\n[^named]: First line.\n  Second line with **bold** and another[^other].\n\n  Second paragraph.\n\n[^other]: Other definition.\n\nAfter notes.'));
  assert.equal(doc.querySelectorAll('.footnote-item').length, 2);
  assert.equal(doc.querySelectorAll('.footnote-ref').length, 3);
  assert.ok(doc.getElementById('fnref1:1'));
  assert.equal(doc.querySelector('.footnote-item strong')?.textContent, 'bold');
  assert.equal(doc.querySelectorAll('#fn1 .obsidian-footnote-content p').length, 2);
  assert.match(doc.body.textContent ?? '', /missing\[\^unknown\]/);
  assert.match(doc.body.textContent ?? '', /After notes/);
});

test('nested inline footnotes preserve escaped brackets and code stays literal', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  const doc = dom(f.render('Nested ^[outer ^[inner] with \\[literal\\]]. `^[code]`\n\n```md\n[^fake]: code\n```'));
  assert.equal(doc.querySelectorAll('.footnote-item').length, 2);
  assert.match(doc.querySelector('#fn1')?.textContent ?? '', /\[literal\]/);
  assert.match(doc.querySelector('code')?.textContent ?? '', /\^\[code\]/);
});

test('late footnote rules from another Markdown extension do not create a second footer', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  f.md.block.ruler.before('reference', 'footnote_def', () => { throw new Error('Foreign definition rule ran'); });
  f.md.inline.ruler.before('link', 'footnote_ref', () => { throw new Error('Foreign reference rule ran'); });
  f.md.inline.ruler.before('link', 'footnote_inline', () => { throw new Error('Foreign inline rule ran'); });
  f.md.core.ruler.after('inline', 'footnote_tail', state => {
    if (state.env.footnotes) throw new Error('Foreign footer state was populated');
  });
  const source = 'Reference[^n] and ^[inline].\n\n[^n]: Definition.';
  for (let index = 0; index < 2; index++) {
    const doc = dom(f.render(source));
    assert.equal(doc.querySelectorAll('.obsidian-footnotes').length, 1);
    assert.equal(doc.querySelectorAll('.footnote-item').length, 2);
  }
});

test('whole-note embeds rebase nested links and Markdown images to the embedded file', async t => {
  const f = await fixture(t, {
    'Main.md': '', 'sub/Note.md': '# Embedded\n\n[[Neighbor]]\n\n![alt|90](picture.svg)',
    'sub/Neighbor.md': '', 'sub/picture.svg': '<svg/>'
  });
  const doc = dom(f.render('![[sub/Note]]'));
  assert.equal(doc.querySelectorAll('.obsidian-note-embed').length, 1);
  assert.equal(doc.querySelector('.obsidian-embed-content a')?.getAttribute('href'), 'sub/Neighbor.md');
  const image = doc.querySelector('img');
  assert.match(image?.src ?? '', /\/sub\/picture\.svg$/);
  assert.equal(image?.getAttribute('width'), '90');
  assert.equal(image?.getAttribute('alt'), 'alt');
  assert.match(doc.querySelector('h1')?.id ?? '', /^obsidian-embed-1-embedded$/);
});

test('heading embeds include subheadings and exclude the next peer heading', async t => {
  const f = await fixture(t, { 'Main.md': '', 'Note.md': '# First\nfirst body\n## Child\nchild body\n# Last\nlast body' });
  const doc = dom(f.render('![[Note#First]]'));
  assert.match(doc.body.textContent ?? '', /first body/);
  assert.match(doc.body.textContent ?? '', /child body/);
  assert.doesNotMatch(doc.body.textContent ?? '', /last body/);
  const section = findSection(f.md, f.vault.read(path.join(f.root, 'Note.md'))!, 'First#Child');
  assert.equal(section?.anchor, 'child');
});

test('partial embeds retain footnote and reference-link definitions outside the selected section', async t => {
  const f = await fixture(t, {
    'Main.md': '',
    'Note.md': '# Selected\nReference[^n] and [linked][target].\n\n# Other\nUnrelated content\n\n[^n]: External definition\n  on two lines\n\n[target]: https://example.com "Title"'
  });
  const doc = dom(f.render('![[Note#Selected]]'));
  assert.equal(doc.querySelectorAll('.footnote-item').length, 1);
  assert.match(doc.querySelector('.footnote-item')?.textContent ?? '', /External definition\non two lines/);
  assert.equal(doc.querySelector('.obsidian-embed-content a[title="Title"]')?.getAttribute('href'), 'https://example.com');
  assert.doesNotMatch(doc.body.textContent ?? '', /Unrelated content/);
});

test('block IDs support paragraphs, structured blocks and list items without code false positives', async t => {
  const note = 'A paragraph. ^paragraph\n\n> Quote body\n\n^quote\n\n- one ^one\n- two\n\n^list\n\n```md\nFake ^fake\n```';
  const f = await fixture(t, { 'Main.md': '', 'Note.md': note });
  const doc = dom(f.render(note));
  assert.equal(doc.querySelector('#obsidian-block-paragraph')?.textContent, 'A paragraph.');
  assert.equal(doc.querySelector('#obsidian-block-quote')?.tagName, 'BLOCKQUOTE');
  assert.equal(doc.querySelector('#obsidian-block-list')?.tagName, 'UL');
  assert.equal(doc.querySelector('#obsidian-block-one')?.tagName, 'LI');
  assert.equal(findSection(f.md, note, '^fake'), undefined);
  const embedded = dom(f.render('![[Note#^quote]]\n\n![[Note#^one]]'));
  assert.match(embedded.body.textContent ?? '', /Quote body/);
  assert.match(embedded.body.textContent ?? '', /one/);
  assert.doesNotMatch(embedded.body.textContent ?? '', /two/);
  assert.equal(embedded.querySelector('[id="obsidian-block-one"]'), null);
});

test('block anchors do not attach later quotes to a list that already ended', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  const doc = dom(f.render('- Item\n\n> Text ^quote\n'));
  assert.equal(doc.querySelector('li')?.id, '');
  assert.equal(doc.querySelector('blockquote p')?.id, 'obsidian-block-quote');
});

test('cycles, depth and missing fragments produce readable errors', async t => {
  const f = await fixture(t, { 'Main.md': '![[A]]', 'A.md': '![[B]]', 'B.md': '![[A]]' });
  assert.match(f.render('![[A]]'), /Cyclic embed stopped/);
  f.settings.maxEmbedDepth = 1;
  assert.match(f.render('![[A]]'), /Maximum embed depth/);
  assert.match(f.render('![[A#Missing]]'), /Embedded heading or block not found/);
});

test('images use width/height, and escaped table pipes do not break cells', async t => {
  const f = await fixture(t, { 'Main.md': '', 'Note.md': '', 'picture.svg': '<svg/>' });
  const source = '| Link | Image |\n| -- | -- |\n| [[Note\\|Label]] | ![[picture.svg\\|120x80]] |';
  const doc = dom(f.render(source));
  assert.equal(doc.querySelectorAll('tbody td').length, 2);
  assert.equal(doc.querySelector('a')?.textContent, 'Label');
  assert.equal(doc.querySelector('img')?.getAttribute('width'), '120');
  assert.equal(doc.querySelector('img')?.getAttribute('height'), '80');
});

test('Obsidian image embeds support natural size, width and width by height', async t => {
  const f = await fixture(t, { 'Main.md': '', 'picture.svg': '<svg/>' });
  const env = f.environment();
  const doc = dom(f.md.render('![[picture.svg]]\n\n![[picture.svg|100]]\n\n![[picture.svg|100x145]]', env));
  const images = [...doc.querySelectorAll('img')];
  assert.equal(images.length, 3);
  assert.deepEqual(images.map(image => image.getAttribute('width')), [null, '100', '100']);
  assert.deepEqual(images.map(image => image.getAttribute('height')), [null, null, '145']);
  assert.ok(images.every(image => image.src === f.host.resourceUri(path.join(f.root, 'picture.svg'), env)));
  assert.ok(images.every(image => image.alt === 'picture.svg'));
  assert.equal(env.containingImages?.size, 1);
});

test('Markdown image sizing works for external URLs and keeps descriptive alt text', async t => {
  const f = await fixture(t, { 'Main.md': '', 'picture.svg': '<svg/>' });
  const source = '![250](https://example.com/photo.jpg)\n\n![100x145](https://example.com/photo.jpg)\n\n![설명|120x80](picture.svg)\n\n![설명](picture.svg)\n\n`![250](https://example.com/photo.jpg)`';
  const doc = dom(f.render(source));
  const images = [...doc.querySelectorAll('img')];
  assert.deepEqual(images.map(image => image.getAttribute('width')), ['250', '100', '120', null]);
  assert.deepEqual(images.map(image => image.getAttribute('height')), [null, '145', '80', null]);
  assert.deepEqual(images.map(image => image.alt), ['', '', '설명', '설명']);
  assert.equal(images[0].src, 'https://example.com/photo.jpg');
  assert.match(images[2].src, /\/picture\.svg$/);
  assert.equal(doc.querySelector('code')?.textContent, '![250](https://example.com/photo.jpg)');
});

test('audio embeds use vault resources and controls, including inside an embedded note', async t => {
  const formats = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm', 'aac', 'opus'];
  const files: Record<string, string> = {
    'Main.md': '', 'sub/Note.md': '![[Recording & demo.wav]]', 'sub/Recording & demo.wav': ''
  };
  for (const format of formats) files[`audio/Sample.${format}`] = '';
  const f = await fixture(t, files);
  const doc = dom(f.render(formats.map(format => `![[audio/Sample.${format}]]`).join('\n\n') + '\n\n![[sub/Note]]'));
  const players = [...doc.querySelectorAll('audio')];
  assert.equal(players.length, formats.length + 1);
  assert.ok(players.every(player => player.controls && player.preload === 'metadata'));
  for (let index = 0; index < formats.length; index++) {
    assert.match(players[index].src, new RegExp(`/audio/Sample\\.${formats[index]}$`));
    assert.equal(players[index].querySelector('a')?.getAttribute('data-href'), `audio/Sample.${formats[index]}`);
  }
  assert.match(players.at(-1)!.src, /\/sub\/Recording%20&%20demo\.wav$/);
  assert.equal(players.at(-1)!.querySelector('a')?.getAttribute('href'), 'sub/Recording%20%26%20demo.wav');
  assert.equal(doc.querySelector('.obsidian-embed-error'), null);
});

test('list block embeds preserve nested, ordered and task lists without surrounding text', async t => {
  const lists = [
    '- list item 1\n- list item 2',
    '- parent **bold**\n  - child\n- sibling',
    '3. third\n4. fourth',
    '- [ ] todo\n- [x] done'
  ];
  const f = await fixture(t, { 'Main.md': '', 'My note.md': '' });
  for (const [index, list] of lists.entries()) {
    const source = `Before list.\n\n${list}\n\n^my-list-id\n\nAfter list.`;
    f.dirty.set(path.join(f.root, 'My note.md'), source);
    const doc = dom(f.render('![[My note#^my-list-id]]'));
    const body = doc.querySelector('.obsidian-embed-content')!;
    assert.ok(body.querySelector('ul, ol'), String(index));
    assert.doesNotMatch(body.textContent ?? '', /Before list|After list|\^my-list-id/);
    if (index === 0) assert.deepEqual([...body.querySelectorAll('li')].map(item => item.textContent?.trim()), ['list item 1', 'list item 2']);
    if (index === 1) {
      assert.equal(body.querySelector('li ul li')?.textContent, 'child');
      assert.equal(body.querySelector('strong')?.textContent, 'bold');
    }
    if (index === 2) assert.equal(body.querySelector('ol')?.getAttribute('start'), '3');
    if (index === 3) assert.deepEqual([...body.querySelectorAll<HTMLInputElement>('input')].map(input => input.checked), [false, true]);
  }
});

test('wiki labels and embed sizes work when table parsers retain escaped pipes', async t => {
  const f = await fixture(t, { 'Main.md': '', 'notes/Linked note.md': '# Implementation', 'attachments/preview.svg': '<svg/>' });
  // Preserve the cell source that multimd-table passes to the inline parser.
  const env = f.environment();
  const tokens = f.md.parseInline('[[notes/Linked note\\|표시 이름]] ![[attachments/preview.svg\\|100]] ![[attachments/preview.svg\\|120x80]]', env);
  const doc = dom(f.md.renderer.render(tokens, f.md.options, env));
  assert.equal(doc.querySelector('a')?.textContent, '표시 이름');
  assert.equal(doc.querySelector('a')?.getAttribute('href'), 'notes/Linked%20note.md');
  assert.equal(doc.querySelector('.is-unresolved, .obsidian-embed-error'), null);
  const images = [...doc.querySelectorAll('img')];
  assert.deepEqual(images.map(image => image.getAttribute('width')), ['100', '120']);
  assert.equal(images[1].getAttribute('height'), '80');
  assert.ok(images.every(image => image.src.endsWith('/attachments/preview.svg')));
  assert.deepEqual(parseWiki('[[notes/Linked note#Implementation\\|표시\\|이름]]'), {
    target: 'notes/Linked note', fragment: 'Implementation', label: '표시|이름', raw: '[[notes/Linked note#Implementation\\|표시\\|이름]]'
  });
  const code = dom(f.render('`[[notes/Linked note\\|표시 이름]]`'));
  assert.equal(code.querySelector('code')?.textContent, '[[notes/Linked note\\|표시 이름]]');
});

test('standard Markdown links and images inside embeds use correct source paths', async t => {
  const f = await fixture(t, { 'Main.md': '', 'sub/Note.md': '[Sibling](Sibling.md#Hello%20world)\n\n![[picture.svg|60]]', 'sub/Sibling.md': '# Hello world', 'sub/picture.svg': '<svg/>' });
  const doc = dom(f.render('![[sub/Note]]'));
  assert.equal(doc.querySelector('.obsidian-embed-content a')?.getAttribute('data-href'), 'sub/Sibling.md#hello-world');
  assert.match(doc.querySelector('img')?.src ?? '', /\/sub\/picture\.svg$/);
});

test('embeds use unsaved contents and isolate footnote IDs between copies', async t => {
  const f = await fixture(t, { 'Main.md': '', 'Note.md': 'old' });
  f.dirty.set(path.join(f.root, 'Note.md'), 'unsaved[^n]\n\n[^n]: footnote');
  const doc = dom(f.render('![[Note]]\n\n![[Note]]'));
  assert.match(doc.body.textContent ?? '', /unsaved/);
  const ids = [...doc.querySelectorAll('[id]')].map(element => element.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('embedded source maps do not scroll the parent editor to another note line', async t => {
  const f = await fixture(t, { 'Main.md': '', 'Note.md': '# Heading\n\nBody' });
  f.md.core.ruler.push('mock_vscode_source_map', state => {
    for (const token of state.tokens) if (token.map && token.type !== 'inline') {
      token.attrSet('data-line', String(token.map[0]));
      token.attrJoin('class', 'code-line');
    }
  });
  const doc = dom(f.render('paragraph\n\n![[Note]]'));
  assert.ok(doc.querySelector('.obsidian-embed-block[data-line="2"]'));
  assert.equal(doc.querySelectorAll('.obsidian-embed-content [data-line]').length, 0);
  assert.equal(doc.querySelectorAll('.obsidian-embed-content .code-line').length, 0);
});


test('footnote backlinks show reference order, hover text and distinct repeated destinations', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  const source = '# Title\n\nFirst[^n] and again[^n].\nNext line[^n] with "quoted" <text>.\n\n> [!note] Title[^n]\n> Body[^n]\n\n| Header |\n| --- |\n| Cell[^n] |\n\nInline ^[inline note].\n\n[^n]: Definition.';
  const doc = dom(f.render(source));
  const links = [...doc.querySelectorAll('#fn1 .obsidian-footnote-backref')];
  assert.deepEqual(links.map(link => link.textContent), ['↑1', '↑2', '↑3', '↑4', '↑5', '↑6']);
  assert.equal(links[2].getAttribute('title'), 'Next line with "quoted" <text>.');
  assert.equal(links[4].getAttribute('title'), 'Body');
  assert.equal(links[4].getAttribute('aria-label'), '5번째 참조 본문으로 이동');
  for (const link of links) assert.ok(doc.getElementById(link.getAttribute('href')!.slice(1)));
  assert.equal(doc.querySelector('#fn2 .obsidian-footnote-backref')?.textContent, '↑1');
});

test('partial embed backlinks restart reference order and isolate destinations', async t => {
  const f = await fixture(t, { 'Main.md': '', 'Note.md': '# Before\n\nIntro\n\n# Selected\nText[^n]\n\n[^n]: Note' });
  const doc = dom(f.render('![[Note#Selected]]\n\n![[Note#Selected]]'));
  const links = [...doc.querySelectorAll('.obsidian-footnote-backref')];
  assert.deepEqual(links.map(link => link.textContent), ['↑1', '↑1']);
  assert.notEqual(links[0].getAttribute('href'), links[1].getAttribute('href'));
  for (const link of links) assert.ok(doc.getElementById(link.getAttribute('href')!.slice(1)));
});
