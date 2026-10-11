import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { IndexService } from '../src/index/query';
import { startIndexWatch, type IndexRefreshResult } from '../src/index/watch';

async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!await condition()) { if (Date.now() > deadline) throw new Error('Watch result timed out.'); await delay(20); }
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'chroma-watch-'));
  const root = path.join(directory, 'notes'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'a.md'), '# One\n[[Target]]\n');
  await fs.writeFile(path.join(root, 'b.md'), '# Two\n');
  const service = new IndexService(root, path.join(root, 'cache'));
  const snapshots: IndexRefreshResult[] = [], errors: unknown[] = [];
  const snapshot = async () => JSON.parse(await fs.readFile(service.cacheFile, 'utf8'));
  return { directory, root, service, snapshots, errors, snapshot, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('watch updates persisted snapshots on save, atomic replacement, rename, creation and deletion', { timeout: 15000 }, async () => {
  const f = await fixture();
  const handle = await startIndexWatch(f.service, { debounceMs: 60, pollIntervalMs: 30000, onRefresh: result => f.snapshots.push(result), onError: error => f.errors.push(error) });
  try {
    assert.equal(f.snapshots[0].documentCount, 2);
    for (const title of ['First save', 'Second save', 'Modified']) await fs.writeFile(path.join(f.root, 'a.md'), `# ${title}\n[[Target]]\n`);
    await until(async () => (await f.snapshot()).documents.find((d: any) => d.file === 'a.md').sections[0].title === 'Modified');
    assert.equal(f.snapshots.at(-1)!.parsed, 1); assert.equal(f.snapshots.at(-1)!.reused, 1);
    const generation = f.snapshots.at(-1)!.generation;
    await fs.writeFile(path.join(f.root, '.atomic-save'), '# Replaced\n');
    await fs.rename(path.join(f.root, '.atomic-save'), path.join(f.root, 'a.md'));
    await until(async () => (await f.snapshot()).documents.find((d: any) => d.file === 'a.md').sections[0].title === 'Replaced');
    assert.ok(f.snapshots.at(-1)!.generation > generation);
    await fs.mkdir(path.join(f.root, 'nested'));
    await fs.writeFile(path.join(f.root, 'nested', 'target.md'), '---\naliases: Target\n---\n# Target\n');
    await until(async () => (await f.snapshot()).documents.length === 3);
    await fs.writeFile(path.join(f.root, 'nested', 'target.md'), '# Nested edit\n');
    await until(async () => (await f.snapshot()).documents.find((d: any) => d.file === 'nested/target.md').sections[0].title === 'Nested edit');
    await fs.rename(path.join(f.root, 'nested'), path.join(f.root, 'moved'));
    await until(async () => (await f.snapshot()).documents.some((d: any) => d.file === 'moved/target.md'));
    await fs.writeFile(path.join(f.root, 'moved', 'target.md'), '# Moved edit\n');
    await until(async () => (await f.snapshot()).documents.find((d: any) => d.file === 'moved/target.md').sections[0].title === 'Moved edit');
    await fs.rm(path.join(f.root, 'moved'), { recursive: true });
    await until(async () => (await f.snapshot()).documents.length === 2);
    assert.equal(f.snapshots.at(-1)!.removed, 1);
    assert.deepEqual(f.errors, []);
  } finally { await handle.close(); await f.cleanup(); }
});

test('watch includes config, bibliography and assets; excludes hidden trees, symlinks and its cache', { timeout: 15000 }, async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.root, 'a.md'), '---\nbibliography: refs.bib\n---\n# One\n![A](image.png)\n');
  await fs.writeFile(path.join(f.root, 'refs.bib'), '@article{one, title={First}}\n');
  let refreshCalls = 0;
  const execute = f.service.execute.bind(f.service);
  f.service.execute = (...args) => { refreshCalls++; return execute(...args); };
  const handle = await startIndexWatch(f.service, { debounceMs: 50, pollIntervalMs: 30000, onRefresh: result => f.snapshots.push(result), onError: error => f.errors.push(error) });
  try {
    await fs.writeFile(path.join(f.root, 'myst.yml'), 'version: 1\nproject:\n  math:\n    "\\\\RR": "\\\\mathbb{R}"\n');
    await until(() => f.snapshots.length >= 2);
    let count = f.snapshots.length;
    await fs.writeFile(path.join(f.root, 'refs.bib'), '@article{two, title={Second}}\n');
    await until(async () => (await f.snapshot()).documents.find((d: any) => d.file === 'a.md').bibliographyKeys.includes('two'));
    assert.ok(f.snapshots.length > count);
    await fs.writeFile(path.join(f.root, 'image.png'), 'image fixture');
    await until(async () => (await f.snapshot()).documents.find((d: any) => d.file === 'a.md').images[0].resolution?.status === 'found');
    for (const name of ['.hidden', 'node_modules', '_build']) {
      await fs.mkdir(path.join(f.root, name)); await fs.writeFile(path.join(f.root, name, 'skip.md'), '# Skip\n');
    }
    const outside = path.join(f.directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'skip.md'), '# Outside\n');
    await fs.symlink(outside, path.join(f.root, 'linked'));
    // Directory/symlink creation may cause one unchanged scan; no cache feedback loop.
    await delay(220); count = f.snapshots.length;
    const settledCalls = refreshCalls;
    await fs.writeFile(path.join(f.root, '.hidden', 'skip.md'), '# Hidden edit\n');
    await fs.writeFile(path.join(outside, 'skip.md'), '# Outside edit\n');
    await delay(220);
    assert.equal(f.snapshots.length, count);
    assert.equal(refreshCalls, settledCalls, 'cache and excluded files must not trigger repeated refreshes');
    assert.deepEqual((await f.snapshot()).documents.map((d: any) => d.file), ['a.md', 'b.md']);
    assert.deepEqual(f.errors, []);
  } finally { await handle.close(); await f.cleanup(); }
});

test('watch reparses registered plugin changes without changing the Markdown source', { timeout: 10000 }, async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.root, 'myst.yml'), 'project:\n  plugins: [plugin.mjs]\n');
  await fs.writeFile(path.join(f.root, 'plugin.mjs'), `export default {roles:[{name:'custom', run:()=>[]}]};`);
  await fs.writeFile(path.join(f.root, 'a.md'), '# One\n{custom}`value`\n');
  // Short polling also covers coalesced native events during concurrent test runs.
  const handle = await startIndexWatch(f.service, { debounceMs: 40, pollIntervalMs: 120, onRefresh: result => f.snapshots.push(result), onError: error => f.errors.push(error) });
  const diagnostics = async () => (await f.snapshot()).documents.find((d: any) => d.file === 'a.md').diagnostics as { code: string; message: string }[];
  try {
    assert.ok(!(await diagnostics()).some(d => d.code === 'mystSyntax'));
    await fs.writeFile(path.join(f.root, 'plugin.mjs'), `export default {roles:[{name:'renamed', run:()=>[]}]};`);
    await until(async () => (await diagnostics()).some(d => d.message === 'unknown role: custom'));
    await fs.writeFile(path.join(f.root, 'plugin.mjs'), `export default {roles:[{name:'custom', run:()=>[]}]};`);
    await until(async () => !(await diagnostics()).some(d => d.code === 'mystSyntax'));
    await fs.rm(path.join(f.root, 'plugin.mjs'));
    await until(async () => (await diagnostics()).some(d => d.code === 'pluginDefinitionsUnavailable'));
    assert.deepEqual(f.errors, []);
  } finally { await handle.close(); await f.cleanup(); }
});

test('watch excludes the same physical cache when configured through a symlink alias', { timeout: 10000 }, async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.root, 'cache'));
  const alias = path.join(f.directory, 'cache-alias'); await fs.symlink(path.join(f.root, 'cache'), alias);
  const service = new IndexService(f.root, alias);
  let calls = 0; const execute = service.execute.bind(service);
  service.execute = (...args) => { calls++; return execute(...args); };
  const handle = await startIndexWatch(service, { debounceMs: 30, pollIntervalMs: 30000 });
  try {
    await delay(180); const settled = calls;
    await delay(180); assert.equal(calls, settled);
    const snapshot = JSON.parse(await fs.readFile(service.cacheFile, 'utf8'));
    assert.deepEqual(snapshot.documents.map((d: any) => d.file), ['a.md', 'b.md']);
  } finally { await handle.close(); await f.cleanup(); }
});

test('watch polling reattaches replaced roots and close cancels cache-lock waits', { timeout: 15000 }, async () => {
  const f = await fixture();
  const handle = await startIndexWatch(f.service, { debounceMs: 10, pollIntervalMs: 80, onRefresh: result => f.snapshots.push(result), onError: error => f.errors.push(error) });
  try {
    await fs.rename(f.root, path.join(f.directory, 'old'));
    await fs.mkdir(f.root); await fs.writeFile(path.join(f.root, 'new.md'), '# New root\n');
    await until(async () => { try { return (await f.snapshot()).documents.some((d: any) => d.file === 'new.md'); } catch { return false; } });
    await fs.writeFile(path.join(f.root, 'new.md'), '# Second\n');
    await until(async () => (await f.snapshot()).documents[0].sections[0].title === 'Second');
    const lock = path.join(path.dirname(f.service.cacheFile), 'lock'); await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, owner: 'test' }));
    await fs.writeFile(path.join(f.root, 'new.md'), '# Waiting\n'); await delay(100);
    const start = Date.now(); await handle.close(); assert.ok(Date.now() - start < 1000);
    await fs.rm(lock, { recursive: true });
    assert.deepEqual(f.errors, []);
  } finally { await handle.close(); await f.cleanup(); }
});

for (const mode of ['text', 'json', 'debug']) test(`CLI watch ${mode} output updates the cache and exits cleanly`, { timeout: 15000 }, async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [path.resolve('dist/cli.cjs'), 'watch', '--cache-dir', path.dirname(path.dirname(f.service.cacheFile)), '--debounce-ms', '40', ...(mode === 'text' ? [] : [`--${mode}`])], { cwd: f.root });
  const closed = once(child, 'close'); let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const results = () => stdout.split('\n').slice(0, -1).filter(Boolean);
  try {
    await until(() => results().length > 0);
    if (mode === 'text') assert.equal(results()[0], 'Indexed 2 documents.');
    else if (mode === 'json') assert.deepEqual(JSON.parse(results()[0]), { event: 'indexed', complete: true, documents: 2 });
    else {
      const record = JSON.parse(results()[0]);
      assert.equal(record.schemaVersion, 1); assert.equal(record.documentCount, 2); assert.equal(record.root, f.service.root); assert.ok(record.cacheFile);
    }
    await fs.writeFile(path.join(f.root, 'a.md'), '# CLI saved\n');
    await until(() => results().length >= 2);
    assert.equal((await f.snapshot()).documents.find((d: any) => d.file === 'a.md').sections[0].title, 'CLI saved');
    child.kill('SIGINT'); assert.equal((await closed)[0], 0);
    assert.doesNotMatch(stderr, /invalidRoot|invalidArguments|cacheLocked/);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await f.cleanup(); }
});
