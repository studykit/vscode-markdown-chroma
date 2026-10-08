import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';
import { crossReferenceSource, assertCrossReferences } from './cross-references';
import { manualFootnoteSource, mixedFootnoteSource, assertFootnoteNumbers } from './footnote-numbering';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('studykit.markdown-chroma');
  assert.ok(extension, 'Development extension is installed');
  await extension.activate();
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const showcase = await vscode.workspace.openTextDocument(path.join(root, 'Showcase.md'));
  await vscode.window.showTextDocument(showcase);
  await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
  const render = () => vscode.commands.executeCommand<string>('markdown.api.render', showcase);
  const html = await render();
  assert.ok(html);
  assert.match(html, /<table class="frontmatter"/);
  assert.doesNotMatch(html, /obsidian-properties/);
  assert.match(html, /obsidian-callout/);
  assert.match(html, /obsidian-note-embed/);
  assert.match(html, /obsidian-embed-\d+-implementation/);
  assert.match(html, /width="240"/);
  assert.doesNotMatch(html, /This comment must not be visible/);
  assert.match(html, /data-href="notes\/Linked%20note\.md/);
  assert.match(html, /<a class="obsidian-link" href="notes\/Linked%20note\.md" data-href="notes\/Linked%20note\.md">연결된 노트<\/a>/);
  assert.match(html, /<a class="obsidian-link" href="notes\/Linked%20note\.md#implementation" data-href="notes\/Linked%20note\.md#implementation">제목 링크<\/a>/);
  assert.match(html, /<a class="obsidian-link" href="#obsidian-block-checklist" data-href="#obsidian-block-checklist">블록 링크<\/a>/);
  assert.doesNotMatch(html, /<kbd>/);
  assert.match(html, /<a class="obsidian-link" href="notes\/Linked%20note\.md" data-href="notes\/Linked%20note\.md">표시 이름<\/a>/);
  assert.match(html, /<img [^>]*width="100"[^>]*class="obsidian-image"/);
  assert.doesNotMatch(html, /Embedded file not found/);
  assert.match(html, /footnote-item/);
  assert.equal((html.match(/class="footnotes obsidian-footnotes"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /↑/);
  assert.match(html, /class="obsidian-footnote-backref" href="#fnref1"[^>]*>↩[₀-₉]*<\/a>/);
  assert.match(html, /obsidian-block-checklist/);
  console.log('PASS: built-in markdown.api.render loads the plugin and renders all showcase syntax');

  const document = new JSDOM(html).window.document;
  const footnoteDocument = {
    uri: showcase.uri, version: -1,
    getText: () => '# Title\n\nFirst[^n] and again[^n].\nNext[^n] with "quotes".\n\n[^n]: Note.'
  };
  const footnoteHtml = (await vscode.commands.executeCommand<string>('markdown.api.render', footnoteDocument))!;
  const footnoteDom = new JSDOM(footnoteHtml).window.document;
  const backrefs = [...footnoteDom.querySelectorAll('.obsidian-footnote-backref')];
  assert.deepEqual(backrefs.map(link => link.textContent), ['↩₁', '↩₂', '↩₃']);
  assert.ok(backrefs.every(link => !link.hasAttribute('title')));
  for (const link of backrefs) assert.ok(footnoteDom.getElementById(link.getAttribute('href')!.slice(1)));
  console.log('PASS: actual Markdown renderer produces small return links without tooltips and unique targets');
  for (const prefix of ['', '{kbd}`Ctrl`\n\n']) {
    for (const [source, numbers] of [[manualFootnoteSource, ['1', '3']], [mixedFootnoteSource, ['2', '4', '1', '5', '3', '2']]] as const) {
      const input = { uri: showcase.uri, version: -1, getText: () => prefix + source };
      const rendered = (await vscode.commands.executeCommand<string>('markdown.api.render', input))!;
      assertFootnoteNumbers(new JSDOM(rendered).window.document, [...numbers]);
    }
  }
  console.log('PASS: actual Markdown and MyST renderers preserve manual footnote numbers and bracketed labels');

  const audio = document.querySelector('audio.obsidian-media');
  assert.ok(audio);
  assert.ok(audio.hasAttribute('controls'));
  assert.equal(audio.getAttribute('preload'), 'metadata');
  assert.match(audio.getAttribute('src') ?? '', /\/attachments\/sample\.wav$/);
  const listEmbed = [...document.querySelectorAll('.obsidian-note-embed')].find(embed =>
    embed.querySelector('.obsidian-embed-title a')?.getAttribute('href') === 'notes/Embedded%20list.md#obsidian-block-my-list-id');
  assert.ok(listEmbed);
  const listContent = listEmbed.querySelector('.obsidian-embed-content')!;
  assert.equal(listContent.querySelectorAll('li').length, 5);
  assert.equal(listContent.querySelector('li ul li')?.textContent?.trim(), '중첩 목록도 유지합니다.');
  assert.doesNotMatch(listContent.textContent ?? '', /포함되지 않습니다|\^my-list-id/);
  const sizedImages = {
    uri: vscode.Uri.file(path.join(root, 'Image sizing integration.md')), version: -1,
    getText: () => '![250](https://example.com/photo.jpg)\n\n![100x145](https://example.com/photo.jpg)'
  };
  const imageHtml = (await vscode.commands.executeCommand<string>('markdown.api.render', sizedImages))!;
  const images = [...new JSDOM(imageHtml).window.document.querySelectorAll('img')];
  assert.deepEqual(images.map(image => image.getAttribute('width')), ['250', '100']);
  assert.deepEqual(images.map(image => image.getAttribute('height')), [null, '145']);
  console.log('PASS: native preview renders audio controls, a full nested list embed and external image dimensions');

  const linked = await vscode.workspace.openTextDocument(path.join(root, 'notes/Linked note.md'));
  const edit = new vscode.WorkspaceEdit();
  edit.insert(linked.uri, new vscode.Position(linked.lineCount, 0), '\nUnsaved integration content.\n');
  await vscode.workspace.applyEdit(edit);
  assert.match((await render())!, /Unsaved integration content/);
  console.log('PASS: note embeds read unsaved VS Code document contents');

  const markdownSettings = vscode.workspace.getConfiguration('markdown');
  const previousFrontmatter = markdownSettings.inspect<string>('preview.frontMatter')?.globalValue;
  const propertiesDocument = {
    uri: showcase.uri, version: -1,
    getText: () => '---\naliases: [Preview demo]\nrelated: "[[notes/Linked note]]"\ntitle: "<img src=x onerror=alert(1)>"\n---\n\nBody'
  };
  const renderProperties = () => vscode.commands.executeCommand<string>('markdown.api.render', propertiesDocument);
  try {
    await markdownSettings.update('preview.frontMatter', 'table', vscode.ConfigurationTarget.Global);
    const table = (await renderProperties())!;
    assert.match(table, /<table class="frontmatter"/);
    assert.match(table, /<td><ul><li>Preview demo<\/li><\/ul><\/td>/);
    assert.match(table, /<td>\[\[notes\/Linked note\]\]<\/td>/);
    assert.match(table, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(table, /obsidian-properties|<a |<img /);
    await markdownSettings.update('preview.frontMatter', 'codeBlock', vscode.ConfigurationTarget.Global);
    assert.match((await renderProperties())!, /<pre class="frontmatter hljs"/);
    await markdownSettings.update('preview.frontMatter', 'hide', vscode.ConfigurationTarget.Global);
    const hidden = (await renderProperties())!;
    assert.doesNotMatch(hidden, /frontmatter|Preview demo|related/);
    assert.match(hidden, /Body/);
  } finally {
    await markdownSettings.update('preview.frontMatter', previousFrontmatter, vscode.ConfigurationTarget.Global);
  }
  console.log('PASS: frontmatter uses the native VS Code table, codeBlock and hide renderers');

  const scratch = vscode.Uri.file(path.join(root, 'Integration scratch.md'));
  try {
    await vscode.workspace.fs.writeFile(scratch, Buffer.from('# Scratch\n\nIntegration watcher content.'));
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
    const virtual = { uri: showcase.uri, version: -1, getText: () => '![[Integration scratch]]' };
    assert.match((await vscode.commands.executeCommand<string>('markdown.api.render', virtual))!, /Integration watcher content/);
  } finally { await vscode.workspace.fs.delete(scratch); }
  console.log('PASS: refreshed vault indexes include newly created files');

  await vscode.commands.executeCommand('obsidianMarkdown.showPreview');
  const hasPreview = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab =>
    tab.input instanceof vscode.TabInputWebview || (tab.input instanceof vscode.TabInputCustom && tab.input.viewType.includes('markdown')));
  if (!hasPreview()) await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('Markdown preview tab did not open.')); }, 10000);
    const subscription = vscode.window.tabGroups.onDidChangeTabs(() => {
      if (hasPreview()) { clearTimeout(timeout); subscription.dispose(); resolve(); }
    });
  });
  assert.ok(hasPreview());
  console.log('PASS: the built-in Markdown preview opens in an actual VS Code window');

  const mystRoot = vscode.workspace.workspaceFolders!.find(folder => path.basename(folder.uri.fsPath) === 'myst')!.uri.fsPath;
  const crossReferences = {
    uri: vscode.Uri.file(path.join(mystRoot, 'cross-references-test.md')), version: -1,
    getText: () => crossReferenceSource
  };
  const crossReferenceHtml = (await vscode.commands.executeCommand<string>('markdown.api.render', crossReferences))!;
  assertCrossReferences(new JSDOM(crossReferenceHtml).window.document);
  console.log('PASS: actual VS Code renderer resolves MyST reference names, numbers, formatting and all anchors');
  for (const name of ['index', 'layout', 'syntax']) {
    const doc = await vscode.workspace.openTextDocument(path.join(mystRoot, `${name}.md`));
    const html = (await vscode.commands.executeCommand<string>('markdown.api.render', doc))!;
    const dom = new JSDOM(html).window.document;
    assert.doesNotMatch(dom.body.textContent ?? '', /:::\{|:label:|:class:|\{note\}/);
    assert.match(html, /<table class="frontmatter"/);
    if (name === 'index') {
      assert.ok(dom.querySelector('.myst-admonition'));
      assert.ok(dom.querySelector('.katex'));
      assert.ok(dom.querySelector('.myst-tabs [role="tab"]'));
      assert.ok(dom.querySelector('.myst-grid .myst-card'));
      assert.match(dom.body.textContent ?? '', /notebook output: 42/i);
      assert.match(dom.body.textContent ?? '', /include directive/);
    } else if (name === 'layout') {
      assert.equal(dom.querySelectorAll('.myst-aside').length, 4);
      assert.ok(dom.querySelector('figure figcaption strong'));
      assert.ok(dom.querySelector('video[controls]'));
    } else {
      assert.ok(dom.querySelector('details#yaml-options-note'));
      assert.ok(dom.querySelector('details#inline-options-tip'));
      assert.ok(dom.querySelector('#inline-options-span'));
      assert.ok(dom.querySelector('.myst-glossary'));
      assert.ok(dom.querySelector('.myst-mermaid'));
    }
    console.log(`PASS: native markdown.api.render renders MyST ${name} without a project server`);
  }
  const configUri = vscode.Uri.file(path.join(mystRoot, 'myst.yml'));
  try {
    await vscode.workspace.fs.writeFile(configUri, Buffer.from('version: 1\nproject:\n  math:\n    "\\\\RR": "\\\\mathbb{R}"\n  settings:\n    parser:\n      dollarmath: false\n'));
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
    const source = { uri: vscode.Uri.file(path.join(mystRoot, 'config-test.md')), version: -1, getText: () => '$x$ {math}`\RR`' };
    const html = (await vscode.commands.executeCommand<string>('markdown.api.render', source))!;
    const dom = new JSDOM(html).window.document;
    assert.match(dom.body.textContent ?? '', /\$x\$/);
    assert.equal(dom.querySelectorAll('.katex').length, 1);
    assert.equal(dom.querySelector('.katex-error'), null);
    console.log('PASS: native preview applies optional myst.yml parser settings and math macros');
  } finally {
    await vscode.workspace.fs.delete(configUri);
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
  }
  const myst = await vscode.workspace.openTextDocument(path.join(mystRoot, 'syntax.md'));
  await vscode.window.showTextDocument(myst);
  await vscode.commands.executeCommand('markdown.showPreviewToSide', myst.uri);
  assert.ok(hasPreview());
  console.log('PASS: default VS Code Markdown preview opens MyST documents');
}
