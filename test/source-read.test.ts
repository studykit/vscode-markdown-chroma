import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { IndexService } from '../src/index/query';
import { MarkdownIndex, MAX_DOCUMENT_BYTES } from '../src/index/project';
import { runCli } from '../src/index/cli';
import { assertRetrievalResult } from './retrieval-contract';

async function fixture(t: { after(callback: () => Promise<unknown>): void }) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'chroma-source-read-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'docs'), cache = path.join(root, 'cache'); await fs.mkdir(root);
  return { directory, root, cache, service: new IndexService(root, cache) };
}

test('observed source lines select exact repeated sections; raw reads need no index and enforce root/cache boundaries', async t => {
  const f = await fixture(t);
  const source = '---\ntitle: Guide\n---\n# Guide\n## Same\nFirst needle\n## Same\nSecond needle\n';
  await fs.writeFile(path.join(f.root, 'a.md'), source);
  const raw = await f.service.execute({ command: 'read-lines', arguments: { file: 'a.md', startLine: 6, endLine: 6 } });
  assert.ok('content' in raw); assert.equal(raw.content, 'First needle\n');
  await assert.rejects(fs.stat(f.cache), { code: 'ENOENT' });
  for (const [line, expected, absent] of [[6, 'First needle', 'Second needle'], [8, 'Second needle', 'First needle']] as const) {
    const result = await f.service.execute({ command: 'read-section', arguments: { file: 'a.md', line } });
    assert.ok('content' in result); assert.match(result.content, new RegExp(expected)); assert.doesNotMatch(result.content, new RegExp(absent));
  }
  await assert.rejects(f.service.execute({ command: 'read-section', arguments: { file: 'a.md', line: 2 } }), { code: 'notASection' });
  await assert.rejects(f.service.execute({ command: 'read-section', arguments: { file: 'a.md', line: 6, title: 'Same' } }), { code: 'invalidArguments' });
  const fm = await f.service.execute({ command: 'read-frontmatter', arguments: { file: 'a.md' } });
  assert.ok('content' in fm); assert.equal(fm.content, '---\ntitle: Guide\n---\n');
  await fs.writeFile(path.join(f.root, 'broken.md'), '---\na: 1\na: 2\n---\n```{unknown}\nNeedle\n```\n');
  const broken = await f.service.execute({ command: 'read-lines', arguments: { file: 'broken.md', startLine: 6, endLine: 6 } });
  assert.ok('content' in broken); assert.equal(broken.complete, true); assert.equal(broken.content, 'Needle\n');
  await fs.writeFile(path.join(f.directory, 'outside.md'), 'outside'); await fs.symlink(path.join(f.directory, 'outside.md'), path.join(f.root, 'link.md'));
  await fs.writeFile(path.join(f.cache, 'excluded.md'), 'cache body');
  await fs.mkdir(path.join(f.root, '.hidden')); await fs.writeFile(path.join(f.root, '.hidden', 'secret.md'), 'hidden');
  await assert.rejects(f.service.execute({ command: 'read-lines', arguments: { file: '../outside.md', startLine: 1 } }), { code: 'outsideRoot' });
  await assert.rejects(f.service.execute({ command: 'read-lines', arguments: { file: 'link.md', startLine: 1 } }), { code: 'outsideRoot' });
  for (const file of ['cache/excluded.md', '.hidden/secret.md', 'missing.md'])
    await assert.rejects(f.service.execute({ command: 'read-lines', arguments: { file, startLine: 1 } }), { code: 'fileNotFound' });
});

test('line reads preserve CRLF, clamp EOF, validate hashes/encoding/size and bypass an index lock', async t => {
  const f = await fixture(t); const source = '# Guide\r\nFirst\r\nNeedle\r\nLast';
  await fs.writeFile(path.join(f.root, 'a.md'), source);
  const index = new MarkdownIndex(f.root, f.cache); const lock = path.join(path.dirname(index.cacheFile), 'lock');
  await fs.mkdir(lock, { recursive: true }); await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, owner: 'test' }));
  const result = await f.service.execute({ command: 'read-lines', arguments: { file: 'a.md', startLine: 2, endLine: 3 } });
  assert.ok('content' in result && 'sourceHash' in result); assert.equal(result.content, 'First\r\nNeedle\r\n');
  const tail = await f.service.execute({ command: 'read-lines', arguments: { file: 'a.md', startLine: 3 } });
  assert.ok('content' in tail); assert.equal(tail.content, 'Needle\r\nLast');
  await assert.rejects(f.service.execute({ command: 'read-lines', arguments: { file: 'a.md', startLine: 5 } }), { code: 'lineNotFound' });
  await assert.rejects(f.service.execute({ command: 'read-lines', arguments: { file: 'a.md', startLine: 3, endLine: 2 } }), { code: 'invalidArguments' });
  await fs.writeFile(path.join(f.root, 'a.md'), source + ' changed');
  await assert.rejects(f.service.execute({ command: 'read-lines', arguments: { file: 'a.md', startLine: 2, sourceHash: result.sourceHash } }), { code: 'documentChanged' });
  await fs.writeFile(path.join(f.root, 'bad.md'), Buffer.from([0xff]));
  await assert.rejects(f.service.execute({ command: 'read-lines', arguments: { file: 'bad.md', startLine: 1 } }), { code: 'invalidEncoding' });
  await fs.writeFile(path.join(f.root, 'large.md'), 'x'.repeat(MAX_DOCUMENT_BYTES + 1));
  await assert.rejects(f.service.execute({ command: 'read-lines', arguments: { file: 'large.md', startLine: 1 } }), { code: 'fileTooLarge' });
  await assert.rejects(f.service.execute({ command: 'read-lines', arguments: { file: 'a.md', startLine: 1 } }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('CLI line reads are raw text, JSON stays concise, and literal match is no longer a command', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.md'), '# Guide\nBefore\nNeedle\nAfter\n');
  const cli = async (...args: string[]) => {
    let stdout = '', stderr = '';
    const code = await runCli([...args, '--root', f.root, '--cache-dir', f.cache], { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
    return { stdout, stderr, code };
  };
  assert.equal((await cli('read-lines', 'a.md', '--start', '2', '--end', '3')).stdout, 'Before\nNeedle\n');
  const json = JSON.parse((await cli('read-lines', 'a.md', '--start', '2', '--json')).stdout); assertRetrievalResult(json);
  assert.deepEqual(json, { complete: true, file: 'a.md', content: 'Before\nNeedle\nAfter\n' });
  const debug = JSON.parse((await cli('read-lines', 'a.md', '--start', '2', '--debug')).stdout);
  assert.equal(debug.startLine, 2); assert.equal(debug.endLine, 4); assert.match(debug.sourceHash, /^sha256:/);
  assert.doesNotMatch((await cli('--help')).stdout, /match <text>/);
  const removed = await cli('match', 'Needle'); assert.equal(removed.code, 2); assert.match(removed.stderr, /Unknown command: match/);
  for (const args of [['read-lines', 'a.md'], ['read-lines', 'a.md', '--start', '0'], ['read-lines', 'a.md', '--start', '1.5'], ['read-lines', 'a.md', '--start', '3', '--end', '2'], ['read-section', 'a.md', '--line', '3', '--title', 'Guide']])
    assert.equal((await cli(...args)).code, 2, JSON.stringify(args));
});
