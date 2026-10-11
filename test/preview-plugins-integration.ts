import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';

/** Verify generated content through the host's actual built-in Markdown renderer. */
export async function verifyPreviewPlugins(extensionPath: string, root: string) {
  const scratch = await fs.mkdtemp(path.join(root, 'preview-plugin-'));
  const configuration = vscode.workspace.getConfiguration('markdownChroma.preview', vscode.Uri.file(scratch));
  const previous = configuration.inspect('projectPlugins')?.workspaceFolderValue;
  const page = path.join(scratch, 'nested/page.md');
  await fs.mkdir(path.dirname(page));
  const original = await fs.readFile(path.join(extensionPath, 'test/fixtures/myst-documentation-plugin.mjs'), 'utf8');
  const source = '# Ordinary heading\n\n:::{myst:directive} code\n:::\n\n{myst:directive}`code`\n\nOrdinary content.';
  const virtual = { uri: vscode.Uri.file(page), version: -1, getText: () => source };
  const render = async (document: typeof virtual = virtual) => (await vscode.commands.executeCommand<string>('markdown.api.render', document))!;
  const waitFor = async (predicate: (html: string) => boolean, document: typeof virtual = virtual) => {
    const deadline = Date.now() + 8000;
    let html = await render(document);
    while (!predicate(html) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); html = await render(document); }
    assert.ok(predicate(html), html); return html;
  };
  try {
    await fs.writeFile(page, source);
    await fs.writeFile(path.join(scratch, 'myst.yml'), 'version: 1\nextends: [./project.yml]\n');
    await fs.writeFile(path.join(scratch, 'project.yml'), 'project:\n  plugins: [./directives.mjs]\n');
    await fs.writeFile(path.join(scratch, 'directives.mjs'), original);
    await configuration.update('projectPlugins', false, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
    assert.match(await render(), /Unsupported or invalid MyST directive/);
    assert.doesNotMatch(await render(), /id="directive-code"/);
    assert.ok(vscode.workspace.isTrusted, 'Isolated integration workspace is trusted');
    await configuration.update('projectPlugins', true, vscode.ConfigurationTarget.WorkspaceFolder);
    const html = await waitFor(html => html.includes('id="directive-code"') && !html.includes('Loading MyST'));
    const dom = new JSDOM(html).window.document;
    assert.match(dom.querySelector('h2#directive-code')?.textContent ?? '', /code directive/);
    assert.ok(dom.querySelector('#directive-code-arg'));
    assert.ok(dom.querySelector('#directive-code-body'));
    assert.ok(dom.querySelector('#directive-code-linenos'));
    assert.ok(dom.querySelector('a[href="#directive-code"]'));
    assert.match(dom.body.textContent ?? '', /Ordinary content/);
    assert.equal(dom.querySelector('.myst-error'), null);
    console.log('PASS: opt-in Preview renders official MyST code directive documentation and role links from inherited configuration in a nested document');

    const generated = `import { value } from './helper.mjs'; export default {
      directives: [{ name: 'generated', alias: ['generated-alias'], arg: { type: String, required: true },
        options: { suffix: { type: String, alias: ['ending'] } }, body: { type: 'myst' },
        run(data) { return [{ type: 'heading', depth: 2, identifier: 'generated-target', children: [{ type: 'text', value: data.arg }] },
          { type: 'paragraph', children: [{ type: 'text', value: value + data.options.suffix }] }, ...data.body]; }
      }], roles: [{ name: 'generated-ref', alias: ['generated-reference'], body: { type: String }, run(data) { return [{ type: 'crossReference', identifier: 'generated-target', children: [{ type: 'text', value: data.body }] }]; } }]
    };`;
    await fs.writeFile(path.join(scratch, 'directives.mjs'), generated);
    await fs.writeFile(path.join(scratch, 'helper.mjs'), `export const value = 'Saved helper ';`);
    const generatedSource = ':::{generated-alias} Generated title\n:ending: suffix\n\n**Body passed**\n:::\n\n{generated-reference}`Generated reference`\n\nOrdinary content.';
    const generatedPage = { ...virtual, getText: () => generatedSource };
    let generatedHtml = await waitFor(html => html.includes('Saved helper suffix') && !html.includes('Loading MyST'), generatedPage);
    assert.match(generatedHtml, /<h2[^>]*>Generated title<\/h2>/);
    assert.match(generatedHtml, /<strong>Body passed<\/strong>/);
    assert.match(generatedHtml, /href="#generated-target">Generated reference<\/a>/);
    assert.doesNotMatch(generatedHtml, /myst-error/);
    const canonicalPage = { ...virtual, getText: () => generatedSource.replace('generated-alias', 'generated')
      .replace(':ending:', ':suffix:').replace('generated-reference', 'generated-ref') };
    const canonicalHtml = await waitFor(html => html.includes('Saved helper suffix') && !html.includes('Loading MyST'), canonicalPage);
    assert.equal(canonicalHtml, generatedHtml);
    console.log('PASS: custom directive, option and role aliases produce the same rendered HTML as their registered names');
    await fs.writeFile(path.join(scratch, 'helper.mjs'), `export const value = 'Changed helper ';`);
    generatedHtml = await waitFor(html => html.includes('Changed helper suffix') && !html.includes('Loading MyST'), generatedPage);
    assert.doesNotMatch(generatedHtml, /Saved helper/);
    const pluginDocument = await vscode.workspace.openTextDocument(path.join(scratch, 'helper.mjs'));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(pluginDocument.uri, new vscode.Range(pluginDocument.positionAt(0), pluginDocument.positionAt(pluginDocument.getText().length)), `export const value = 'Unsaved code must not execute ';`);
    await vscode.workspace.applyEdit(edit);
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
    assert.match(await waitFor(html => html.includes('Changed helper suffix') && !html.includes('Loading MyST'), generatedPage), /Changed helper/);
    console.log('PASS: Preview passes directive aliases, options, body and role references; saved helper changes refresh the module graph while unsaved plugin code stays inactive');

    const second = path.join(scratch, 'second'); await fs.mkdir(second);
    await fs.writeFile(path.join(second, 'myst.yml'), 'project:\n  plugins: [plugin.mjs]\n');
    await fs.writeFile(path.join(second, 'plugin.mjs'), `export default { directives: [{ name: 'generated', run() { return [{ type: 'text', value: 'Other project only' }]; } }] };`);
    const secondPage = { uri: vscode.Uri.file(path.join(second, 'page.md')), version: -1, getText: () => ':::{generated}\n:::' };
    await fs.writeFile(secondPage.uri.fsPath, secondPage.getText());
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
    assert.match(await waitFor(html => html.includes('Other project only') && !html.includes('Loading MyST'), secondPage), /Other project only/);
    const firstAgain = await waitFor(html => html.includes('Changed helper suffix') && !html.includes('Loading MyST'), generatedPage);
    assert.doesNotMatch(firstAgain, /Other project only/);
    await fs.writeFile(path.join(scratch, 'directives.mjs'), `export default { directives: [{ name: 'generated', run() { throw new Error('Preview plugin failure'); } }] };`);
    const failurePage = { ...virtual, getText: () => ':::{generated}\n:::\n\nOrdinary content.' };
    assert.match(await waitFor(html => html.includes('Preview plugin failure') && !html.includes('Loading MyST'), failurePage), /Ordinary content/);
    await fs.writeFile(path.join(scratch, 'directives.mjs'), `export default { directives: [{ name: 'generated', run() { while (true) {} } }] };`);
    assert.match(await waitFor(html => html.includes('execution timed out'), failurePage), /Ordinary content/);
    await configuration.update('projectPlugins', false, vscode.ConfigurationTarget.WorkspaceFolder);
    assert.match(await render(failurePage), /Unsupported or invalid MyST directive/);
    console.log('PASS: Preview isolates project definitions and survives plugin exceptions and execution timeouts; disabling the setting restores ordinary rendering');
  } finally {
    await configuration.update('projectPlugins', previous, vscode.ConfigurationTarget.WorkspaceFolder);
    await fs.rm(scratch, { recursive: true, force: true });
    await vscode.commands.executeCommand('obsidianMarkdown.refreshVault');
  }
}
