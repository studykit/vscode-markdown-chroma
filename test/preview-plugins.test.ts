import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PreviewPluginManager } from '../src/preview-plugins/manager';
import { extendMystMarkdown } from '../src/myst';
import { fixture } from './helpers';

const plugin = `import { u } from 'unist-builder';
import { mystParse } from 'myst-parser';
import { defaultDirectives } from 'myst-directives';
export default {
  directives: [{ name: 'demo:generated', alias: ['demo:generated-alias'], arg: { type: String, required: true },
    options: { suffix: { type: String, alias: ['ending'] } }, body: { type: 'myst' },
    run(data) { return [u('heading', { depth: 2, identifier: 'generated-target' }, [u('text', data.arg)]),
      u('paragraph', [u('text', data.options.suffix ?? '')]), ...data.body,
      ...mystParse('**Bundled parser works**').children,
      u('paragraph', [u('text', defaultDirectives.find(d => d.name === 'code').name)])]; }
  }],
  roles: [{ name: 'demo:generated-ref', alias: ['demo:generated-reference'], body: { type: String, required: true },
    run(data) { return [u('crossReference', { identifier: 'generated-target' }, [u('text', data.body)])]; }
  }]
};`;
const source = ':::{demo:generated-alias} Generated heading\n:ending: Option passed\n\nBody with **formatting**.\n:::\n\n{demo:generated-reference}`Read it`\n\nUnrelated paragraph.';

async function renderReady(render: () => string) {
  const deadline = Date.now() + 6000;
  let html = render();
  while (html.includes('Loading MyST project plugins') && Date.now() < deadline) { await delay(20); html = render(); }
  assert.doesNotMatch(html, /Loading MyST project plugins/, 'Plugin render completes');
  return html;
}

test('opt-in and workspace trust gate all project plugin execution', async t => {
  const f = await fixture(t, { 'Main.md': '', 'myst.yml': 'project:\n  plugins: [plugin.mjs]\n', 'plugin.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./executed', import.meta.url), 'yes'); ${plugin}` });
  const manager = new PreviewPluginManager(() => {}, path.join(__dirname, '../preview-plugin-worker.cjs')); t.after(() => manager.dispose());
  const project = { plugins: ['./plugin.mjs'] };
  assert.equal(manager.parse(source, path.join(f.root, 'Main.md'), f.root, project, false, true), undefined);
  assert.match(manager.parse(source, path.join(f.root, 'Main.md'), f.root, project, true, false)!.errors.join(), /trusted local workspace/);
  await delay(50);
  await assert.rejects(fs.access(path.join(f.root, 'executed')));
});

test('custom directives and roles render identically by registered names and aliases, including options and parsed bodies', async t => {
  const f = await fixture(t, { 'Main.md': '', 'myst.yml': 'project:\n  plugins: [plugin.js]\n', 'plugin.js': plugin });
  const manager = new PreviewPluginManager(() => {}, path.join(__dirname, '../preview-plugin-worker.cjs')); t.after(() => manager.dispose());
  f.host.parseMystPlugins = (input, file, project) => manager.parse(input, file, f.root, project, true, true);
  extendMystMarkdown(f.md, f.host);
  const html = await renderReady(() => f.render(source));
  assert.match(html, /<h2[^>]*id="generated-target"[^>]*>Generated heading<\/h2>/);
  assert.match(html, /Option passed/); assert.match(html, /Body with <strong>formatting<\/strong>/);
  assert.match(html, /<strong>Bundled parser works<\/strong>/);
  assert.match(html, /href="#generated-target">Read it<\/a>/);
  assert.match(html, /Unrelated paragraph/);
  assert.doesNotMatch(html, /myst-error/);
  const canonical = source.replace('demo:generated-alias', 'demo:generated')
    .replace(':ending:', ':suffix:').replace('demo:generated-reference', 'demo:generated-ref');
  assert.equal(await renderReady(() => f.render(canonical)), html);
  // A cached AST is cloned before mutable transforms/reference resolution.
  assert.equal(f.render(source), html);
});

test('plugin failures, asynchronous callbacks, transforms and unsupported nodes are actionable and partial', async t => {
  const code = `export default { transforms: [() => {}], directives: [
    { name: 'throws', run() { throw new Error('Intentional failure'); } },
    { name: 'asynchronous', async run() { return []; } },
    { name: 'custom', run() { return [{ type: 'customWidget', value: '<unsafe>' }]; } },
    { name: 'good', run() { return [{ type: 'paragraph', children: [{ type: 'text', value: 'Still rendered' }] }]; } }
  ] };`;
  const f = await fixture(t, { 'Main.md': '', 'myst.yml': 'project:\n  plugins: [plugin.mjs, missing.mjs]\n', 'plugin.mjs': code });
  const manager = new PreviewPluginManager(() => {}, path.join(__dirname, '../preview-plugin-worker.cjs')); t.after(() => manager.dispose());
  f.host.parseMystPlugins = (input, file, project) => manager.parse(input, file, f.root, project, true, true);
  extendMystMarkdown(f.md, f.host);
  const html = await renderReady(() => f.render(['throws', 'asynchronous', 'custom', 'good'].map(name => `:::{${name}}\n:::`).join('\n\n') + '\n\nOrdinary text.'));
  for (const text of ['Intentional failure', 'Asynchronous run()', 'unsupported output node customWidget', 'transforms are not supported', 'missing.mjs', 'Still rendered', 'Ordinary text']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<unsafe>/);
});

test('official MyST documentation plugin renders code directive documentation and role references', async t => {
  const original = await fs.readFile(path.join(__dirname, '../../test/fixtures/myst-documentation-plugin.mjs'), 'utf8');
  const f = await fixture(t, { 'Main.md': '', 'myst.yml': 'project:\n  plugins: [directives.mjs]\n', 'directives.mjs': original });
  const manager = new PreviewPluginManager(() => {}, path.join(__dirname, '../preview-plugin-worker.cjs')); t.after(() => manager.dispose());
  f.host.parseMystPlugins = (input, file, project) => manager.parse(input, file, f.root, project, true, true);
  extendMystMarkdown(f.md, f.host);
  const html = await renderReady(() => f.render(':::{myst:directive} code\n:::\n\n{myst:directive}`code`'));
  assert.match(html, /<h2[^>]*id="directive-code"/);
  assert.match(html, /Directive Argument/); assert.match(html, /Directive Body/);
  assert.match(html, /linenos/); assert.match(html, /<dl/);
  assert.match(html, /href="#directive-code"/); assert.doesNotMatch(html, /myst-error/);
});

test('fresh worker dependency graphs pick up saved helper edits and stay separate across projects', async t => {
  const f = await fixture(t, {
    'Main.md': '', 'myst.yml': 'project:\n  plugins: [plugin.mjs]\n',
    'plugin.mjs': `import { value } from './helper.mjs'; export default { directives: [{ name: 'hello', run() { return [{ type: 'paragraph', children: [{ type: 'text', value }] }]; } }] };`,
    'helper.mjs': `export const value = 'First project';`,
    'second/page.md': '', 'second/myst.yml': 'project:\n  plugins: [plugin.mjs]\n',
    'second/plugin.mjs': `export default { directives: [{ name: 'hello', run() { return [{ type: 'paragraph', children: [{ type: 'text', value: 'Second project' }] }]; } }] };`
  });
  const manager = new PreviewPluginManager(() => {}, path.join(__dirname, '../preview-plugin-worker.cjs')); t.after(() => manager.dispose());
  f.host.parseMystPlugins = (input, file, project) => manager.parse(input, file, f.root, project, true, true);
  extendMystMarkdown(f.md, f.host);
  assert.match(await renderReady(() => f.render(':::{hello}\n:::')), /First project/);
  assert.match(await renderReady(() => f.render(':::{hello}\n:::', 'second/page.md')), /Second project/);
  await fs.writeFile(path.join(f.root, 'helper.mjs'), `export const value = 'Updated helper';`);
  manager.invalidate(path.join(f.root, 'helper.mjs'));
  assert.match(await renderReady(() => f.render(':::{hello}\n:::')), /Updated helper/);
  await fs.unlink(path.join(f.root, 'plugin.mjs'));
  manager.invalidate(path.join(f.root, 'plugin.mjs'));
  assert.match(f.render(':::{hello}\n:::'), /plugin.mjs.*ENOENT/);
});

test('local imports and installed project packages work; missing packages and root escapes fail clearly', async t => {
  const f = await fixture(t, {
    'Main.md': '', 'myst.yml': 'project:\n  plugins: [plugin.mjs]\n',
    'plugin.mjs': `import { value } from 'fixture-package'; export default { directives: [{ name: 'package', run() { return [{ type: 'text', value }]; } }] };`,
    'node_modules/fixture-package/package.json': '{"type":"module","exports":"./index.js"}',
    'node_modules/fixture-package/index.js': `export const value = 'Installed package';`
  });
  const manager = new PreviewPluginManager(() => {}, path.join(__dirname, '../preview-plugin-worker.cjs')); t.after(() => manager.dispose());
  f.host.parseMystPlugins = (input, file, project) => manager.parse(input, file, f.root, project, true, true);
  extendMystMarkdown(f.md, f.host);
  assert.match(await renderReady(() => f.render(':::{package}\n:::')), /Installed package/);
  await fs.writeFile(path.join(f.root, 'plugin.mjs'), `import 'missing-package'; export default {};`);
  manager.invalidate();
  assert.match(await renderReady(() => f.render(':::{package}\n:::')), /missing-package/);
  await fs.writeFile(path.join(f.root, 'plugin.mjs'), `import '../outside.mjs'; export default {};`);
  manager.invalidate();
  assert.match(await renderReady(() => f.render(':::{package}\n:::')), /outside.mjs/);
  await fs.symlink(path.join(f.root, 'plugin.mjs'), path.join(f.root, 'inside.mjs'));
  assert.ok(manager.parse('', path.join(f.root, 'Main.md'), f.root, { plugins: ['https://example.com/plugin.js', '../escape.js', { type: 'executable', path: 'plugin.py' }] }, true, true)!.errors.length === 3);
});

test('runaway loading and directive execution terminate within a bounded time and preserve source preview', async t => {
  const f = await fixture(t, { 'Main.md': '', 'myst.yml': 'project:\n  plugins: [plugin.mjs]\n', 'plugin.mjs': 'while (true) {}' });
  const manager = new PreviewPluginManager(() => {}, path.join(__dirname, '../preview-plugin-worker.cjs'), 1000); t.after(() => manager.dispose());
  f.host.parseMystPlugins = (input, file, project) => manager.parse(input, file, f.root, project, true, true);
  extendMystMarkdown(f.md, f.host);
  assert.match(await renderReady(() => f.render(':::{hang}\n:::\n\nOrdinary source.')), /loading timed out/);
  await fs.writeFile(path.join(f.root, 'plugin.mjs'), `export default { directives: [{ name: 'hang', run() { while (true) {} } }] };`);
  manager.invalidate();
  const html = await renderReady(() => f.render(':::{hang}\n:::\n\nOrdinary source.'));
  assert.match(html, /execution timed out/); assert.match(html, /Ordinary source/);
});

test('more than four concurrent projects finish without evicting pending work or leaking results', async t => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 6; index++) {
    files[`project-${index}/page.md`] = '';
    files[`project-${index}/myst.yml`] = 'project:\n  plugins: [plugin.mjs]\n';
    files[`project-${index}/plugin.mjs`] = `export default { directives: [{ name: 'value', alias: 'value-alias', run() { return [{ type: 'text', value: 'Project ${index}' }]; } }] };`;
  }
  const f = await fixture(t, files);
  const manager = new PreviewPluginManager(() => {}, path.join(__dirname, '../preview-plugin-worker.cjs')); t.after(() => manager.dispose());
  f.host.parseMystPlugins = (input, file, project) => manager.parse(input, file, f.root, project, true, true);
  extendMystMarkdown(f.md, f.host);
  const renders = Array.from({ length: 6 }, (_, index) => () => f.render(':::{value-alias}\n:::', `project-${index}/page.md`));
  const results = await Promise.all(renders.map(renderReady));
  results.forEach((html, index) => { assert.match(html, new RegExp(`Project ${index}`)); assert.doesNotMatch(html, /myst-error/); assert.equal(renders[index](), html); });
});

test('frontmatter cannot select executable plugins and malformed generated nodes preserve the rest of the page', async t => {
  const f = await fixture(t, {
    'Main.md': '', 'myst.yml': 'project:\n  plugins: [plugin.mjs]\n',
    'plugin.mjs': `export default { directives: [
      { name: 'image-error', run() { return [{ type: 'image', url: 42 }]; } },
      { name: 'validation', arg: { type: String, required: true }, validate(data) { return { ...data, arg: data.arg.toUpperCase() }; }, run(data) { return [{ type: 'text', value: data.arg }]; } }
    ] };`,
    'frontmatter.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./frontmatter-executed', import.meta.url), 'yes'); export default {};`
  });
  const manager = new PreviewPluginManager(() => {}, path.join(__dirname, '../preview-plugin-worker.cjs')); t.after(() => manager.dispose());
  f.host.parseMystPlugins = (input, file, project) => manager.parse(input, file, f.root, project, true, true);
  extendMystMarkdown(f.md, f.host);
  const html = await renderReady(() => f.render('---\nplugins: [frontmatter.mjs]\n---\n\n:::{image-error}\n:::\n\n:::{validation} uppercase\n:::\n\nRetained content.'));
  assert.match(html, /image.url must be a string/); assert.match(html, /UPPERCASE/); assert.match(html, /Retained content/);
  await assert.rejects(fs.access(path.join(f.root, 'frontmatter-executed')));
});
