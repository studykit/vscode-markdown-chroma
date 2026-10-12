import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { JSDOM } from 'jsdom';
import { crossReferenceSource, assertCrossReferences } from './cross-references';
import { manualFootnoteSource, mixedFootnoteSource, assertFootnoteNumbers } from './footnote-numbering';
import { verifyPreviewPlugins } from './preview-plugins-integration';
import { glossaryLineBreakSource, assertGlossaryLineBreaks } from './glossary-line-breaks';
import { obsidianBlockSource, assertObsidianBlocks } from './obsidian-blocks';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('studykit.markdown-chroma');
  assert.ok(extension, 'Development extension is installed');
  await extension.activate();
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const provider = extension.exports.mcpProvider as vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition>;
  assert.ok(provider, 'MCP provider is registered on this host');
  const tokenSource = new vscode.CancellationTokenSource();
  const definitions = await provider.provideMcpServerDefinitions(tokenSource.token);
  assert.equal(definitions?.length, vscode.workspace.workspaceFolders!.length);
  const definition = definitions![0];
  assert.equal(definition.cwd?.fsPath, root);
  assert.equal(definition.command, process.execPath);
  assert.ok(await provider.resolveMcpServerDefinition!(definition, tokenSource.token));
  const client = new Client({ name: 'vscode-chroma-integration', version: '1' });
  const transport = new StdioClientTransport({ command: definition.command, args: definition.args,
    cwd: definition.cwd?.fsPath, env: definition.env as Record<string, string>, stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 16);
    const result = await client.callTool({ name: 'list_sections', arguments: { file: 'Showcase.md' } });
    const data = result.structuredContent as { file: string; sections: unknown[] };
    assert.equal(data.file, 'Showcase.md');
    assert.ok(data.sections?.length);
    assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'match_text'));
    const source = await fs.readFile(path.join(root, 'Showcase.md'), 'utf8');
    const line = source.split('\n').findIndex(text => text.includes('Markdown Chroma')) + 1;
    assert.ok(line > 0);
    const read = (await client.callTool({ name: 'read_section', arguments: { file: 'Showcase.md', line } })).structuredContent as any;
    assert.match(read.content, /Markdown Chroma/);
    const batchResult = await client.callTool({ name: 'read_items', arguments: { selections: [
      { kind: 'section', file: 'Showcase.md', line }, { kind: 'section', file: 'Showcase.md', line },
    ] } });
    const batch = batchResult.structuredContent as any;
    assert.equal(batchResult.isError, undefined); assert.equal(batch.items.length, 1);
    assert.match(batch.items[0].content, /Markdown Chroma/);
    assert.equal(batch.items[0].sourceHash, undefined); assert.equal(batch.items[0].startLine, undefined);
    const embedLine = source.split('\n').findIndex(text => text === '![[notes/Linked note#Implementation]]') + 1;
    const expanded = (await client.callTool({ name: 'expand_directive', arguments: { file: 'Showcase.md', line: embedLine } })).structuredContent as any;
    assert.equal(expanded.complete, true); assert.match(expanded.content, /Implementation/); assert.ok(!expanded.content.includes('![[notes/Linked note#Implementation]]'));
  } finally { await client.close(); }
  const configuration = vscode.workspace.getConfiguration('markdownChroma.mcp', vscode.workspace.workspaceFolders![0].uri);
  const initialEnabled = configuration.inspect('enabled')?.workspaceValue;
  const initialRoot = configuration.inspect('root')?.workspaceValue;
  const initialPlugins = configuration.inspect('projectPlugins')?.workspaceValue;
  let changes = 0;
  const listener = provider.onDidChangeMcpServerDefinitions!(() => { changes++; });
  try {
    await configuration.update('projectPlugins', true, vscode.ConfigurationTarget.Workspace);
    const enabledDefinition = (await provider.provideMcpServerDefinitions(tokenSource.token))![0];
    assert.ok(enabledDefinition.args.includes('--allow-project-plugins'));
    assert.equal(await provider.resolveMcpServerDefinition!(definition, tokenSource.token), undefined);
    const scratch = await fs.mkdtemp(path.join(root, 'chroma-expansion-'));
    const pluginClient = new Client({ name: 'vscode-expansion-integration', version: '1' });
    try {
      await fs.writeFile(path.join(scratch, 'myst.yml'), 'project:\n  plugins: [./plugin.mjs]\n');
      await fs.writeFile(path.join(scratch, 'plugin.mjs'), "import {u} from 'unist-builder'; export default {directives:[{name:'host-info',alias:['host-info-alias'],run(){return [u('paragraph',[u('text','Host-generated information')])];}}]};");
      const source = ':::{host-info-alias}\n:::\n';
      await fs.writeFile(path.join(scratch, 'source.md'), source);
      await pluginClient.connect(new StdioClientTransport({ command: enabledDefinition.command, args: enabledDefinition.args, cwd: enabledDefinition.cwd?.fsPath, env: enabledDefinition.env as Record<string,string>, stderr: 'pipe' }));
      const result = await pluginClient.callTool({ name: 'expand_directive', arguments: { file: path.basename(scratch) + '/source.md', line: source.split('\n').findIndex(text => text.includes('{host-info-alias}')) + 1 } });
      assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent)); assert.match((result.structuredContent as any).content, /Host-generated information/);
    } finally { await pluginClient.close(); await fs.rm(scratch, { recursive: true, force: true }); }
    await configuration.update('projectPlugins', false, vscode.ConfigurationTarget.Workspace);
    await configuration.update('enabled', false, vscode.ConfigurationTarget.Workspace);
    assert.equal((await provider.provideMcpServerDefinitions(tokenSource.token))?.length, 0);
    assert.equal(await provider.resolveMcpServerDefinition!(definition, tokenSource.token), undefined);
    await configuration.update('enabled', true, vscode.ConfigurationTarget.Workspace);
    await configuration.update('root', '..', vscode.ConfigurationTarget.Workspace);
    assert.equal((await provider.provideMcpServerDefinitions(tokenSource.token))?.length, 0);
    assert.ok(changes >= 2);
    tokenSource.cancel();
    assert.deepEqual(await provider.provideMcpServerDefinitions(tokenSource.token), []);
  } finally {
    await configuration.update('enabled', initialEnabled, vscode.ConfigurationTarget.Workspace);
    await configuration.update('root', initialRoot, vscode.ConfigurationTarget.Workspace);
    await configuration.update('projectPlugins', initialPlugins, vscode.ConfigurationTarget.Workspace);
    listener.dispose(); tokenSource.dispose();
  }
  console.log('PASS: native MCP provider exposes 16 tools, expands heading embeds and an opt-in custom directive alias through the host runtime, and rechecks launch settings');
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

  const codeSamples = [
    ['javascript', 'const answer = "hello";'],
    ['js', 'const answer = "hello";'],
    ['typescript', 'const answer: string = "hello";'],
    ['python', 'def greet(name):\n    return "hello"'],
    ['py', 'def greet(name):\n    return "hello"'],
    ['json', '{"answer": true}'],
    ['jsonc', '// comment\n{"answer": true}'],
    ['bash', 'echo "hello"'],
    ['html', '<div class="greeting">hello</div>'],
    ['css', '.greeting { color: red; }'],
    ['sql', 'SELECT name FROM notes WHERE id = 42;']
  ];
  for (const [language, code] of codeSamples) {
    for (const source of [
      `\`\`\`${language}\n${code}\n\`\`\``,
      `{kbd}\`Enter\`\n\n\`\`\`${language}\n${code}\n\`\`\``,
      `\`\`\`{code} ${language}\n${code}\n\`\`\``
    ]) {
      const input = { uri: showcase.uri, version: -1, getText: () => source };
      const rendered = (await vscode.commands.executeCommand<string>('markdown.api.render', input))!;
      const block = new JSDOM(rendered).window.document.querySelector('pre code');
      assert.ok(block, `Code block is rendered for ${language}`);
      assert.equal(block.textContent?.trimEnd(), code);
      assert.ok(block.querySelector('[class^="hljs-"]'), `${language} receives native syntax highlighting`);
    }
  }
  for (const language of ['', 'unknown-language']) {
    const code = '<tag> & literal';
    for (const prefix of ['', '{kbd}`Enter`\n\n']) {
      const input = { uri: showcase.uri, version: -1, getText: () => `${prefix}\`\`\`${language}\n${code}\n\`\`\`` };
      const rendered = (await vscode.commands.executeCommand<string>('markdown.api.render', input))!;
      const block = new JSDOM(rendered).window.document.querySelector('pre code');
      assert.equal(block?.textContent?.trimEnd(), code);
      assert.equal(block?.querySelector('span'), null);
    }
  }
  console.log('PASS: native and MyST fenced blocks and code directives highlight 11 language IDs; plain and unknown languages remain escaped text');

  const document = new JSDOM(html).window.document;
  const blockScratch = vscode.Uri.file(path.join(root, 'Block references integration.md'));
  try {
    for (const prefix of ['', '{kbd}`Ctrl`\n\n']) {
      const source = prefix + obsidianBlockSource;
      await vscode.workspace.fs.writeFile(blockScratch, Buffer.from(source));
      const input = { uri: blockScratch, version: -1, getText: () => source };
      const rendered = (await vscode.commands.executeCommand<string>('markdown.api.render', input))!;
      assertObsidianBlocks(new JSDOM(rendered).window.document);
    }
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
    const input = { uri: showcase.uri, version: -1, getText: () => '{kbd}`Ctrl`\n\n[[Block references integration#^item]]\n\n![[Block references integration#^item]]' };
    const rendered = (await vscode.commands.executeCommand<string>('markdown.api.render', input))!;
    const blocks = new JSDOM(rendered).window.document;
    assert.equal(blocks.querySelector('.obsidian-embed-content li')?.textContent?.trim(), 'src/lib/');
    assert.equal(blocks.querySelector('.is-unresolved, .obsidian-embed-error'), null);
  } finally { await vscode.workspace.fs.delete(blockScratch); }
  console.log('PASS: actual Markdown and MyST renderers preserve Obsidian block anchors, wikilinks and list-item embeds');
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
  const previewScratch = await fs.mkdtemp(path.join(mystRoot, 'preview-root-'));
  const sharedName = `${path.basename(previewScratch)}-shared.md`;
  const sharedFile = path.join(mystRoot, sharedName);
  const rootConfig = path.join(mystRoot, 'myst.yml');
  const previewConfiguration = vscode.workspace.getConfiguration('markdownChroma.preview', vscode.Uri.file(previewScratch));
  const previousPreviewRoot = previewConfiguration.inspect('root')?.workspaceFolderValue;
  assert.equal(await fs.access(rootConfig).then(() => true, () => false), false, 'Root fixture has no existing MyST configuration');
  const previewTokenSource = new vscode.CancellationTokenSource();
  try {
    await fs.mkdir(path.join(previewScratch, '.obsidian'));
    await fs.writeFile(path.join(previewScratch, '.obsidian/app.json'), '{}');
    await fs.writeFile(sharedFile, 'Shared preview-root content.');
    await fs.writeFile(rootConfig, 'version: 1\nproject:\n  abbreviations:\n    ROOT: Shared project configuration\n');
    const page = path.join(previewScratch, 'page.md');
    await fs.writeFile(page, `ROOT\n\n\`\`\`{include} ../${sharedName}\n\`\`\`\n\n[[${sharedName.slice(0, -3)}]]`);
    const previewRootDocument = await vscode.workspace.openTextDocument(page);
    const renderRoot = async () => new JSDOM((await vscode.commands.executeCommand<string>('markdown.api.render',
      { uri: previewRootDocument.uri, version: -1, getText: () => previewRootDocument.getText() }))!).window.document;
    await previewConfiguration.update('root', '', vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
    let rendered = await renderRoot();
    assert.match(rendered.body.textContent ?? '', /Shared preview-root content/);
    assert.equal(rendered.querySelector('abbr')?.getAttribute('title'), 'Shared project configuration');
    assert.ok(rendered.querySelector('a.obsidian-link'));
    await previewConfiguration.update('root', path.basename(previewScratch), vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
    rendered = await renderRoot();
    assert.match(rendered.querySelector('.myst-error')?.textContent ?? '', /outside document root/);
    assert.equal(rendered.querySelector('abbr'), null);
    assert.ok(rendered.querySelector('.obsidian-link.is-unresolved'));
    assert.ok((await provider.provideMcpServerDefinitions(previewTokenSource.token))?.some(server => server.cwd?.fsPath === mystRoot));
    await previewConfiguration.update('root', '..', vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
    assert.match((await renderRoot()).body.textContent ?? '', /Shared preview-root content/);
  } finally {
    previewTokenSource.dispose();
    await previewConfiguration.update('root', previousPreviewRoot, vscode.ConfigurationTarget.WorkspaceFolder);
    await fs.rm(previewScratch, { recursive: true, force: true });
    await fs.rm(sharedFile, { force: true });
    await fs.rm(rootConfig, { force: true });
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
  }
  console.log('PASS: generic preview root ignores .obsidian, keeps parent MyST settings/includes accessible, bounds narrowed roots and remains separate from MCP');
  const depthScratch = await fs.mkdtemp(path.join(root, 'preview-depth-'));
  const depthConfiguration = vscode.workspace.getConfiguration('markdownChroma.preview', vscode.Uri.file(depthScratch));
  const previousDepth = depthConfiguration.inspect('maxEmbedDepth')?.workspaceFolderValue;
  try {
    for (const [name, source] of Object.entries({
      'page.md': '', 'obs-a.md': '![[./obs-b]]', 'obs-b.md': 'Nested Obsidian content.',
      'myst-a.md': '```{include} ./myst-b.md\n```', 'myst-b.md': 'Nested MyST content.'
    })) await fs.writeFile(path.join(depthScratch, name), source);
    const depthDocument = await vscode.workspace.openTextDocument(path.join(depthScratch, 'page.md'));
    for (const depth of [1, 2]) {
      await depthConfiguration.update('maxEmbedDepth', depth, vscode.ConfigurationTarget.WorkspaceFolder);
      await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
      for (const [source, content, error] of [
        ['![[./obs-a]]', 'Nested Obsidian content.', /Maximum embed depth/],
        ['```{include} ./myst-a.md\n```', 'Nested MyST content.', /over limit/]
      ] as const) {
        const html = (await vscode.commands.executeCommand<string>('markdown.api.render',
          { uri: depthDocument.uri, version: -1, getText: () => source }))!;
        const rendered = new JSDOM(html).window.document;
        if (depth === 1) {
          assert.match(rendered.body.textContent ?? '', error);
          assert.ok(!rendered.body.textContent?.includes(content));
        } else {
          assert.ok(rendered.body.textContent?.includes(content));
          assert.equal(rendered.querySelector('.obsidian-embed-error, .myst-error'), null);
        }
      }
    }
  } finally {
    await depthConfiguration.update('maxEmbedDepth', previousDepth, vscode.ConfigurationTarget.WorkspaceFolder);
    await fs.rm(depthScratch, { recursive: true, force: true });
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
  }
  console.log('PASS: shared preview maxEmbedDepth setting limits and restores both Obsidian embeds and MyST includes');
  const glossaryInput = { uri: vscode.Uri.file(path.join(mystRoot, 'glossary-line-breaks.md')), version: -1, getText: () => glossaryLineBreakSource };
  const glossaryHtml = (await vscode.commands.executeCommand<string>('markdown.api.render', glossaryInput))!;
  assertGlossaryLineBreaks(new JSDOM(glossaryHtml).window.document);
  console.log('PASS: native preview renders canonical glossary terms, aliases and alias references while preserving ordinary prose formatting');
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
  await verifyPreviewPlugins(extension.extensionPath, mystRoot);
  await vscode.window.showTextDocument(myst);
  await vscode.commands.executeCommand('markdown.showPreviewToSide', myst.uri);
  assert.ok(hasPreview());
  console.log('PASS: default VS Code Markdown preview opens MyST documents');
}
