import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { IndexService, type IndexQuery } from '../src/index/query';
import { MarkdownIndex } from '../src/index/project';
import { readBatch } from '../src/index/batch';
import { runCli } from '../src/index/cli';
import { presentResult } from '../src/index/presentation';
import type { ReadSelection } from '../src/index/types';
import { assertRetrievalResult } from './retrieval-contract';

const guide = '# Guide\r\nIntro.\r\n## First\r\nAlpha😀.\r\n\r\n:::{glossary}\r\nAST\r\n: Tree😀.\r\n:::\r\n\r\n## Left\r\n### Same\r\nLeft.\r\n## Right\r\n### Same\r\nRight.\r\n';
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'chroma-batch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = path.join(root, '.cache');
  await fs.writeFile(path.join(root, 'guide.md'), guide);
  await fs.writeFile(path.join(root, 'tiny.md'), '# Tiny\ny\n');
  return { root, cache, service: new IndexService(root, cache) };
}
const batch = (selections: ReadSelection[], maxChars?: number): IndexQuery => ({ command: 'read', arguments: { selections, maxChars } });

test('batch reads merge overlapping sections/definitions, preserve CRLF and first-selection group order', async t => {
  const f = await fixture(t);
  const q = batch([{ kind: 'section', file: 'tiny.md', title: 'Tiny' },
    { kind: 'section', file: 'guide.md', title: 'First' }, { kind: 'term', file: 'guide.md', name: 'AST' },
    { kind: 'section', file: 'guide.md', title: 'Guide', includeChildren: true }, { kind: 'term', file: 'guide.md', name: 'ast' }]);
  const result = await f.service.execute(q);
  assert.ok('budget' in result); assert.equal(result.items.length, 2);
  const [tiny, merged] = result.items;
  assert.ok(tiny.status === 'ok' && merged.status === 'ok');
  assert.equal(tiny.file, 'tiny.md'); assert.equal(tiny.content, '# Tiny\ny\n');
  assert.equal(merged.content, guide); assert.equal(merged.kind, 'section');
  assert.deepEqual(merged.covers?.map(c => c.kind === 'term' ? c.name : c.title), ['First', 'AST']);
  assert.equal(result.budget.usedChars, [...guide, ...tiny.content].length);
  const json = presentResult(result, q); assertRetrievalResult(json);
  assert.equal(json.complete, true); assert.equal(json.budget, undefined);
  const own = await f.service.execute(batch([{ kind: 'section', file: 'guide.md', title: 'Guide' }]));
  assert.ok('budget' in own && own.items[0].status === 'ok'); assert.equal(own.items[0].content, '# Guide\r\nIntro.\r\n');
});

test('batch budgets omit whole groups, retain later fitting groups and count Unicode code points', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'broken.md'), '---\na: 1\na: 2\n---\n# Broken\n');
  const q = batch([{ kind: 'section', file: 'guide.md', title: 'Guide', includeChildren: true },
    { kind: 'section', file: 'tiny.md', title: 'Tiny' }], 9);
  const result = await f.service.execute(q); assert.ok('budget' in result);
  assert.equal(result.items[0].status, 'omitted'); assert.equal(result.items[1].status, 'ok');
  const json = presentResult(result, q); assertRetrievalResult(json);
  assert.equal(json.complete, false); assert.equal(json.issues, undefined); assert.deepEqual(json.budget, { maxChars: 9, usedChars: 9 });
  const termQ = batch([{ kind: 'term', file: 'guide.md', name: 'AST' }]);
  const term = await f.service.execute(termQ); assert.ok('budget' in term && term.items[0].status === 'ok');
  const chars = [...term.items[0].content].length;
  const exact = await f.service.execute(batch(termQ.command === 'read' ? termQ.arguments.selections! : [], chars));
  assert.ok('budget' in exact); assert.equal(exact.items[0].status, 'ok');
  const short = await f.service.execute(batch([{ kind: 'term', file: 'guide.md', name: 'AST' }], chars - 1));
  assert.ok('budget' in short); assert.equal(short.items[0].status, 'omitted');
});

test('batch selection failures remain partial with candidates and successful reads; hashes and roots are enforced', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'other.md'), '# Other\n\n:::{glossary}\nAST\n: Another.\n:::\n');
  const q = batch([{ kind: 'section', file: 'guide.md', title: 'Same' }, { title: 'Same', file: 'guide.md', kind: 'section' }, { kind: 'term', name: 'AST' },
    { kind: 'section', file: 'guide.md', headingPath: ['Guide', 'Left', 'Same'] },
    { kind: 'section', file: '../outside.md', title: 'Outside' },
    { kind: 'term', file: 'guide.md', name: 'AST', sourceHash: 'sha256:wrong' }]);
  const result = await f.service.execute(q); assert.ok('budget' in result);
  assert.deepEqual(result.items.map(i => i.status), ['error', 'error', 'ok', 'error', 'error']);
  const errors = result.items.filter(i => i.status === 'error');
  assert.deepEqual(errors.map(i => i.error.code), ['ambiguousSection', 'ambiguousTerm', 'outsideRoot', 'documentChanged']);
  const json = presentResult(result, q); assert.equal(json.complete, false); assertRetrievalResult(json);
  assert.ok((json.items as any[])[0].error.candidates[0].headingPath);
  const index = new MarkdownIndex(f.root, f.cache); await index.refresh();
  await fs.writeFile(path.join(f.root, 'tiny.md'), '# Tiny\nChanged.\n');
  const stale = readBatch(index, [{ kind: 'section', file: 'tiny.md', title: 'Tiny' }]);
  assert.equal(stale.items[0].status, 'error');
  if (stale.items[0].status === 'error') assert.equal(stale.items[0].error.code, 'documentChanged');
});

test('the default batch budget omits an oversized fenced section intact and enforces request limits', async t => {
  const f = await fixture(t);
  const large = '# Large\n\n```text\n' + 'x'.repeat(12000) + '\n```\n';
  await fs.writeFile(path.join(f.root, 'large.md'), large);
  const selections: ReadSelection[] = [{ kind: 'section', file: 'large.md', title: 'Large' }, { kind: 'section', file: 'tiny.md', title: 'Tiny' }];
  const limited = await f.service.execute(batch(selections)); assert.ok('budget' in limited);
  assert.deepEqual(limited.budget, { maxChars: 12000, usedChars: 9 });
  assert.equal(limited.items[0].status, 'omitted'); assert.equal(limited.items[1].status, 'ok');
  if (limited.items[0].status === 'omitted') assert.equal(limited.items[0].requiredChars, [...large].length);
  const expanded = await f.service.execute(batch(selections, 200000)); assert.ok('budget' in expanded && expanded.items[0].status === 'ok');
  assert.equal(expanded.items[0].content, large);
  await assert.rejects(f.service.execute(batch(selections, 200001)), { code: 'invalidArguments' });
  await assert.rejects(f.service.execute(batch(Array.from({ length: 101 }, () => selections[0]))), { code: 'invalidArguments' });
});

test('CLI natural batch selections produce readable source, concise JSON, omissions and strict validation', async t => {
  const f = await fixture(t);
  const cli = async (...args: string[]) => {
    let stdout = '', stderr = '';
    const code = await runCli([...args, '--root', f.root, '--cache-dir', f.cache], { stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
    return { code, stdout, stderr };
  };
  const choices = JSON.stringify([{ kind: 'section', file: 'guide.md', title: 'Guide' }, { kind: 'term', file: 'guide.md', name: 'AST' }]);
  const text = await cli('read', '--select', choices); assert.equal(text.code, 0);
  assert.match(text.stdout, /section: Guide/); assert.match(text.stdout, /Tree😀/); assert.doesNotMatch(text.stdout, /## Left/);
  const json = JSON.parse((await cli('read', '--select', choices, '--json')).stdout); assertRetrievalResult(json); assert.equal(json.items.length, 2);
  const omitted = await cli('read', '--select', choices, '--max-chars', '1');
  assert.equal(omitted.code, 1); assert.equal(omitted.stdout, ''); assert.match(omitted.stderr, /Omitted within the read budget/);
  for (const args of [['read', '--select', '{}'], ['read', '--select', '[]'], ['read', '--select', choices, '--id', 'x'],
    ['read', '--id', 'x', '--max-chars', '1'], ['read', '--select', choices, '--max-chars', '0'],
    ['read', '--select', JSON.stringify([{ kind: 'section', file: 'guide.md', title: 'Guide', id: 'guide' }])]])
    assert.equal((await cli(...args)).code, 2, JSON.stringify(args));
});
