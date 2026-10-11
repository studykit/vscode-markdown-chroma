import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PreviewPluginManager, type PluginParseResult } from '../src/preview-plugins/manager';
import { PreviewPluginDiagnostics } from '../src/preview-plugins/diagnostics';
import type { PluginDiagnostic, PluginEvent } from '../src/preview-plugins/events';
import { fixture } from './helpers';

const worker = path.join(__dirname, '../preview-plugin-worker.cjs');
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (!(await predicate())) { assert.ok(Date.now() < deadline, 'Plugin work completes within deadline'); await delay(20); }
}
async function ready(parse: () => PluginParseResult | undefined) {
  let result: PluginParseResult | undefined;
  await until(() => { result = parse(); return !!result && !result.pending; }); return result!;
}
const values = (tree: any): string => tree.value ?? tree.children?.map(values).join('') ?? '';

test('plugin failures retain stack/context, console output, reliable Problems and deduplicated reports', async t => {
  const f = await fixture(t, { 'Main.md': '', 'plugin.mjs': `
    console.log('Loading console marker'); console.error('Stderr console marker');
    export default { directives: [{ name: 'boom', run() { console.log('Callback console marker'); throw new Error('Callback failure'); } }] };
  ` });
  let output = '', located: PluginDiagnostic[] = [];
  const diagnostics = new PreviewPluginDiagnostics({ clear() { output = ''; }, append(value) { output += value; } }, items => { located = items; });
  const manager = new PreviewPluginManager(() => {}, worker, 2000, event => diagnostics.accept(event));
  t.after(() => { manager.dispose(); diagnostics.dispose(); });
  const parse = (source: string) => manager.parse(source, path.join(f.root, 'Main.md'), f.root, { plugins: ['./plugin.mjs'] }, true, true);
  const result = await ready(() => parse('# Heading\n\n:::{boom}\n:::\n'));
  assert.match(values(result.tree), /Callback failure/);
  const problem = located.find(item => item.phase === 'execution')!;
  assert.equal(problem.file, await fs.realpath(path.join(f.root, 'Main.md'))); assert.equal(problem.line, 3); assert.equal(problem.column, 1);
  assert.match(problem.plugin!, /plugin.mjs \(directive boom\)/); assert.match(problem.detail!, /at Object.run/);
  await until(() => { diagnostics.flush(); return output.includes('Callback console marker') && output.includes('Stderr console marker'); });
  assert.match(output, /Loading console marker/); assert.match(output, /\[stdout\]/); assert.match(output, /\[stderr\]/);
  assert.ok(output.includes(await fs.realpath(f.root))); assert.match(output, /Main.md:3:1/);
  for (let i = 0; i < 10; i++) parse('# Heading\n\n:::{boom}\n:::\n');
  diagnostics.flush(); assert.equal(output.match(/\[execution\]/g)?.length, 1);
  await ready(() => parse('Ordinary corrected content.')); assert.deepEqual(located, []);
  assert.equal(manager.reloadDocument(path.join(f.root, 'Main.md')), true);
  await ready(() => parse('Ordinary corrected content.'));
  assert.equal(manager.reloadDocument(path.join(f.root, 'unknown.md')), false);
});

test('pending edits coalesce to latest source while other documents and embeds complete', async t => {
  const f = await fixture(t, { 'Main.md': '', 'Other.md': '', 'Embed.md': '', 'plugin.mjs': `
    import { appendFileSync } from 'node:fs';
    export default { directives: [{ name: 'value', arg: { type: String }, run(data) {
      appendFileSync(new URL('./runs.log', import.meta.url), data.arg + '\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      return [{ type: 'text', value: data.arg }];
    } }] };
  ` });
  let refreshes = 0;
  const manager = new PreviewPluginManager(() => { refreshes++; }, worker); t.after(() => manager.dispose());
  const parse = (value: string, file = 'Main.md') => manager.parse(`:::{value} ${value}\n:::`, path.join(f.root, file), f.root, { plugins: ['./plugin.mjs'] }, true, true);
  parse('first');
  await until(async () => (await fs.readFile(path.join(f.root, 'runs.log'), 'utf8').catch(() => '')).includes('first'));
  parse('other', 'Other.md'); parse('embed', 'Embed.md');
  for (let i = 1; i <= 50; i++) parse(`edit-${i}`);
  parse('latest');
  const latest = await ready(() => parse('latest'));
  assert.equal(values(latest.tree), 'latest');
  assert.equal(values((await ready(() => parse('other', 'Other.md'))).tree), 'other');
  assert.equal(values((await ready(() => parse('embed', 'Embed.md'))).tree), 'embed');
  assert.equal(await fs.readFile(path.join(f.root, 'runs.log'), 'utf8'), 'first\nother\nembed\nlatest\n');
  assert.equal(refreshes, 3, 'Obsolete first completion does not refresh Preview');
});

test('reverting to an active source removes its queued replacement', async t => {
  const f = await fixture(t, { 'Main.md': '', 'plugin.mjs': `
    import { appendFileSync } from 'node:fs';
    export default { directives: [{ name: 'value', arg: { type: String }, run(data) {
      appendFileSync(new URL('./runs.log', import.meta.url), data.arg + '\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      return [{ type: 'text', value: data.arg }];
    } }] };
  ` });
  const manager = new PreviewPluginManager(() => {}, worker); t.after(() => manager.dispose());
  const parse = (value: string) => manager.parse(`:::{value} ${value}\n:::`, path.join(f.root, 'Main.md'), f.root, { plugins: ['./plugin.mjs'] }, true, true);
  parse('original');
  await until(async () => (await fs.readFile(path.join(f.root, 'runs.log'), 'utf8').catch(() => '')).includes('original'));
  parse('obsolete');
  assert.equal(values((await ready(() => parse('original'))).tree), 'original');
  await delay(150); assert.equal(await fs.readFile(path.join(f.root, 'runs.log'), 'utf8'), 'original\n');
});

test('saved-file bursts reload once per root and retain helper/configuration/data coverage', async t => {
  const files = { 'Main.md': '', 'myst.yml': 'project: {}', 'helper.mjs': `export const suffix = ' first';`, 'data.json': '"Data"', 'plugin.mjs': `
    import { appendFileSync, readFileSync } from 'node:fs'; import { suffix } from './helper.mjs';
    appendFileSync(new URL('./loads.log', import.meta.url), 'load\\n');
    export default { directives: [{ name: 'value', run() { return [{ type: 'text', value: JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8')) + suffix }]; } }] };
  ` };
  const a = await fixture(t, files), b = await fixture(t, files);
  const events: PluginEvent[] = [];
  const manager = new PreviewPluginManager(() => {}, worker, 2000, event => events.push(event)); t.after(() => manager.dispose());
  const parse = (root: string) => manager.parse(':::{value}\n:::', path.join(root, 'Main.md'), root, { plugins: ['./plugin.mjs'] }, true, true);
  await ready(() => parse(a.root)); await ready(() => parse(b.root));
  await fs.writeFile(path.join(a.root, 'helper.mjs'), `export const suffix = ' updated';`);
  await fs.writeFile(path.join(a.root, 'data.json'), '"Changed"');
  for (let i = 0; i < 30; i++) for (const file of ['helper.mjs', 'myst.yml', 'data.json']) manager.scheduleInvalidate(path.join(a.root, file));
  manager.scheduleInvalidate(path.join(b.root, 'data.json'));
  assert.equal(values(parse(a.root)!.tree), 'Data first', 'No immediate reset for each event');
  await until(() => events.filter(event => event.type === 'log' && event.message.startsWith('Saved files changed')).length === 2);
  assert.equal(values((await ready(() => parse(a.root))).tree), 'Changed updated');
  await ready(() => parse(b.root));
  for (const root of [a.root, b.root]) assert.equal(await fs.readFile(path.join(root, 'loads.log'), 'utf8'), 'load\nload\n');
  manager.scheduleInvalidate(path.join(a.root, 'data.json')); manager.dispose();
  await delay(350);
  assert.equal(events.filter(event => event.type === 'log' && event.message.startsWith('Saved files changed')).length, 2, 'Shutdown cancels pending reloads');
});

test('manual reload isolates plugin sets inside one root and failed workers stay failed across eviction', async t => {
  const files: Record<string, string> = { 'Main.md': '', 'plugin.mjs': `while (true) {}` };
  for (let i = 0; i < 5; i++) {
    files[`Other-${i}.md`] = '';
    files[`plugin-${i}.mjs`] = `import { appendFileSync } from 'node:fs'; appendFileSync(new URL('./loads-${i}.log', import.meta.url), 'load\\n');
      export default { directives: [{ name: 'value', run() { return [{ type: 'text', value: '${i}' }]; } }] };`;
  }
  const f = await fixture(t, files); const events: PluginEvent[] = [];
  const manager = new PreviewPluginManager(() => {}, worker, 1000, event => events.push(event)); t.after(() => manager.dispose());
  const parse = (i?: number) => manager.parse(':::{value}\n:::', path.join(f.root, i === undefined ? 'Main.md' : `Other-${i}.md`), f.root, { plugins: [i === undefined ? './plugin.mjs' : `./plugin-${i}.mjs`] }, true, true);
  assert.match((await ready(() => parse())).errors.join(), /loading timed out/);
  for (let i = 0; i < 5; i++) await ready(() => parse(i));
  assert.match(parse()!.errors.join(), /loading timed out/);
  assert.equal(events.filter(event => event.type === 'log' && event.message === 'Loading project plugins.' && event.plugins.includes('plugin.mjs')).length, 1);
  assert.equal(manager.reloadDocument(path.join(f.root, 'Other-0.md')), true);
  await ready(() => parse(0)); await ready(() => parse(1));
  assert.equal(await fs.readFile(path.join(f.root, 'loads-0.log'), 'utf8'), 'load\nload\n');
  assert.equal(await fs.readFile(path.join(f.root, 'loads-1.log'), 'utf8'), 'load\n');
});

test('Output and Problems retain bounded history and project-scoped clearing', t => {
  let output = '', located: PluginDiagnostic[] = [];
  const diagnostics = new PreviewPluginDiagnostics({ clear() { output = ''; }, append(value) { output += value; } }, items => { located = items; });
  t.after(() => diagnostics.dispose());
  const issue = { phase: 'execution' as const, reason: 'Failure', file: '/a/page.md', line: 3, column: 1 };
  diagnostics.accept({ type: 'diagnostics', project: 'a', root: '/a', file: issue.file, diagnostics: [issue, { ...issue, column: undefined }, { phase: 'loading', reason: 'Unknown location' }] });
  diagnostics.accept({ type: 'diagnostics', project: 'b', root: '/b', file: '/b/page.md', diagnostics: [{ ...issue, file: '/b/page.md' }] });
  assert.equal(located.length, 2);
  diagnostics.accept({ type: 'clear', project: 'a' }); assert.equal(located.length, 1); assert.equal(located[0].file, '/b/page.md');
  for (let i = 0; i < 100; i++) diagnostics.accept({ type: 'log', root: '/b', plugins: ['plugin.mjs'], level: 'stdout', message: `${i}:` + '한'.repeat(10000) });
  diagnostics.flush(); assert.ok(Buffer.byteLength(output) <= 256 * 1024); assert.ok(output.includes('99:')); assert.equal(/^0:한/m.test(output), false);
  assert.equal(output.includes('\uFFFD'), false, 'Log truncation preserves UTF-8 characters');
  diagnostics.accept({ type: 'clear' }); assert.deepEqual(located, []);
});

test('timeouts from obsolete source retain plugin context without stale Problems positions', async t => {
  const f = await fixture(t, { 'Main.md': '', 'plugin.mjs': `import { writeFileSync } from 'node:fs'; export default { directives: [{ name: 'hang', run() { writeFileSync(new URL('./active', import.meta.url), 'yes'); while (true) {} } }] };` });
  const events: PluginEvent[] = [];
  const manager = new PreviewPluginManager(() => {}, worker, 1000, event => events.push(event)); t.after(() => manager.dispose());
  const parse = (source: string) => manager.parse(source, path.join(f.root, 'Main.md'), f.root, { plugins: ['./plugin.mjs'] }, true, true);
  parse('\n\n:::{hang}\n:::');
  await until(async () => (await fs.readFile(path.join(f.root, 'active'), 'utf8').catch(() => '')) === 'yes');
  parse('The directive was removed.');
  assert.match((await ready(() => parse('The directive was removed.'))).errors.join(), /execution timed out/);
  const timedOut = events.filter(event => event.type === 'diagnostics').flatMap(event => event.diagnostics).find(item => item.phase === 'timeout')!;
  assert.match(timedOut.plugin!, /directive hang/); assert.equal(timedOut.line, undefined); assert.equal(timedOut.column, undefined);
});
