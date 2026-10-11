import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../src/index/cli';
import { presentError } from '../src/index/presentation';
import { assertRetrievalResult } from './retrieval-contract';
import { IndexService } from '../src/index/query';
import { presentResult } from '../src/index/presentation';

test('CLI text and JSON expose retrieval choices while debug retains program records', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'chroma-presentation-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'notes'), cache = path.join(directory, 'cache'); await fs.mkdir(root);
  const source = '---\ntitle: Public guide\nstatus: draft\ntags: project\n---\n# Guide\n## Data\n\n| Name | Value |\n| - | - |\n| A | B |\n\n![Diagram](missing.png)\n\n:::{glossary}\nAST\n: Definition with `sourceHash` as example text.\n:::\n';
  await fs.writeFile(path.join(root, 'guide.md'), source);
  await fs.writeFile(path.join(root, 'linked.md'), '# Linked\n[[guide#Data]]\n');
  const cli = async (...args: string[]) => {
    let stdout = '', stderr = '';
    const code = await runCli([...args, '--root', root, '--cache-dir', cache], { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
    return { code, stdout, stderr, json: () => JSON.parse(stdout) };
  };
  const commands: [string[], string][] = [
    [['index'], 'Indexed 2 documents.\n'],
    [['notes'], '- Public guide (guide.md)\n- Linked (linked.md)\n'],
    [['search', '--where', '{"status":"draft"}'], '- Public guide (guide.md)\n'],
    [['backlinks', 'guide.md'], '- linked.md [Linked]: [[guide#Data]] (wiki)\n'],
    [['tables'], '- guide.md [Guide > Data]: headers: Name | Value\n'],
    [['images'], '- guide.md [Guide > Data]: missing.png; alt: Diagram (missing)\n'],
    [['glossaries'], '- Data (guide.md; 1 term)\n'],
    [['terms'], '- AST (guide.md)\n'],
  ];
  for (const [args, text] of commands) {
    const result = await cli(...args);
    assert.equal(result.code, 0); assert.equal(result.stdout, text); assert.equal(result.stderr, '');
    const json = (await cli(...args, '--json')).json();
    assertRetrievalResult(json); assert.equal(json.complete, true);
  }
  assert.deepEqual((await cli('index', '--json')).json(), { complete: true, documents: 2 });
  assert.deepEqual((await cli('search', '--where', '{"status":"draft"}', '--json')).json(), { complete: true, notes: [{ file: 'guide.md', title: 'Public guide' }] });
  assert.deepEqual((await cli('tables', '--json')).json().tables, [{ file: 'guide.md', headingPath: ['Guide', 'Data'], headers: ['Name', 'Value'] }]);
  assert.deepEqual((await cli('images', '--json')).json().images, [{ file: 'guide.md', headingPath: ['Guide', 'Data'], source: 'missing.png', alt: 'Diagram', missing: true }]);
  assert.deepEqual((await cli('terms', '--json')).json().terms, [{ id: 'guide.md#term-ast', name: 'AST', file: 'guide.md' }]);
  assert.deepEqual((await cli('glossaries', '--json')).json().glossaries, [{ id: 'guide.md#glossary-1', file: 'guide.md', title: 'Data', terms: 1 }]);
  assert.deepEqual((await cli('backlinks', 'guide.md', '--json')).json().backlinks, [{ file: 'linked.md', headingPath: ['Linked'], kind: 'wiki', text: '[[guide#Data]]' }]);
  assert.equal((await cli('sections', 'guide.md')).stdout, 'Guide\n  Data\n');
  assert.equal((await cli('read-section', 'guide.md', '--title', 'Guide', '--no-children')).stdout, '# Guide\n');
  assert.equal((await cli('read-term', 'AST')).stdout, 'AST\n: Definition with `sourceHash` as example text.\n');
  assert.deepEqual((await cli('sections', 'guide.md', '--json')).json(), { complete: true, file: 'guide.md', sections: [{ title: 'Guide', children: [{ title: 'Data' }] }] });
  assert.deepEqual((await cli('read-section', 'guide.md', '--title', 'Guide', '--no-children', '--json')).json(), { complete: true, file: 'guide.md', content: '# Guide\n' });
  assert.deepEqual((await cli('read-term', 'AST', '--json')).json().items, [{ kind: 'term', file: 'guide.md', name: 'AST', content: 'AST\n: Definition with `sourceHash` as example text.\n' }]);
  const detailed = (await cli('notes', '--debug')).json();
  assert.equal(detailed.schemaVersion, 1); assert.equal(detailed.root, await fs.realpath(root));
  assert.equal(detailed.notes[0].properties.status, 'draft'); assert.match(detailed.notes[0].sourceHash, /^sha256:/);
  assert.deepEqual((await cli('notes', '--json', '--debug')).json(), detailed);
  assert.equal((await cli('search', '--where', '{"status":"absent"}')).stdout, 'No notes found.\n');
});

test('compact error candidates retain disambiguation choices without definition metadata', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'chroma-candidates-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'a.md'), '# Terms\n\n:::{glossary}\nAST\n: First.\n:::\n');
  await fs.writeFile(path.join(directory, 'b.md'), '# Terms\n\n:::{glossary}\nAST\n: Second.\n:::\n');
  let stdout = '', stderr = '';
  const code = await runCli(['read-term', 'AST', '--root', directory], { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
  assert.equal(code, 1); assert.equal(stdout, ''); assert.match(stderr, /ambiguousTerm/);
  assert.equal(stderr.split('\n').slice(1).join('\n'), '  - AST (a.md; id: a.md#term-ast)\n  - AST (b.md; id: b.md#term-ast)\n');
  let json = '';
  await runCli(['read-term', 'AST', '--root', directory, '--json'], { stdout: value => { json += value; }, stderr: () => {} });
  assertRetrievalResult(JSON.parse(json));
  assert.deepEqual(JSON.parse(json).items[0].error.candidates, [
    { id: 'a.md#term-ast', name: 'AST', file: 'a.md' }, { id: 'b.md#term-ast', name: 'AST', file: 'b.md' },
  ]);
  const error = presentError({ code: 'cacheWriteFailed', message: 'Cannot save index at /private/cache/file.json' });
  assert.doesNotMatch(error.message, /private|cache|json/);
});

test('CLI partial results and query failures keep text, retrieval JSON and debug metadata distinct', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'chroma-output-errors-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'bad.md'), '---\nvalue: 1\nvalue: 2\n---\n# Still readable\n');
  const cli = async (...args: string[]) => {
    let stdout = '', stderr = '';
    const code = await runCli([...args, '--root', root], { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
    return { code, stdout, stderr };
  };
  const text = await cli('notes'); assert.equal(text.code, 1); assert.equal(text.stdout, '- Still readable (bad.md)\n'); assert.match(text.stderr, /bad.md/);
  const json = await cli('notes', '--json'); assert.equal(json.code, 1); assertRetrievalResult(JSON.parse(json.stdout)); assert.equal(JSON.parse(json.stdout).complete, false);
  assert.ok(JSON.parse(json.stdout).issues.length); assert.doesNotMatch(json.stderr, /invalidFrontmatter/);
  const debug = await cli('notes', '--debug'); assert.equal(JSON.parse(debug.stdout).schemaVersion, 1); assert.match(debug.stderr, /invalidFrontmatter/);
  for (const command of ['backlinks', 'sections', 'read-section']) {
    const args = [command, 'missing.md', ...(command === 'read-section' ? ['--title', 'Missing'] : [])];
    const plain = await cli(...args); assert.equal(plain.stdout, ''); assert.equal(plain.code, 1); assert.match(plain.stderr, /fileNotFound/);
    const concise = await cli(...args, '--json'); assertRetrievalResult(JSON.parse(concise.stdout)); assert.equal(JSON.parse(concise.stdout).error.code, 'fileNotFound');
    const detailed = await cli(...args, '--debug'); assert.equal(JSON.parse(detailed.stdout).schemaVersion, 1);
  }
  const invalid = ['read-section', 'bad.md', '--heading-path', '[]'];
  const plainValidation = await cli(...invalid); assert.equal(plainValidation.code, 2); assert.equal(plainValidation.stdout, '');
  assert.match(plainValidation.stderr, /^invalidArguments: headingPath:/); assert.doesNotMatch(plainValidation.stderr, /"origin"|"minimum"/);
  const jsonValidation = JSON.parse((await cli(...invalid, '--json')).stdout);
  assert.match(jsonValidation.error.message, /^headingPath:/);
  const debugValidation = JSON.parse((await cli(...invalid, '--debug')).stdout);
  assert.ok(Array.isArray(JSON.parse(debugValidation.error.message)));
});

test('retrieval diagnostics are summarized and scoped while Node and debug retain the full snapshot', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'chroma-scoped-issues-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'healthy.md'), '# Healthy\nText.\n');
  await fs.writeFile(path.join(root, 'broken.md'), '---\na: 1\na: 2\n---\n# Broken\n');
  await fs.writeFile(path.join(root, 'mixed.md'), '# Guide\n## Good\nSafe.\n\n:::{glossary}\nAST\n: Tree.\n:::\n\n## Broken\n{unknown}`one` {unknown}`two`\n');
  const cli = async (...args: string[]) => {
    let stdout = '', stderr = '';
    const code = await runCli([...args, '--root', root], { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
    return { code, stdout, stderr, json: () => JSON.parse(stdout) };
  };
  const list = await cli('notes', '--json');
  assert.equal(list.code, 1); assert.equal(list.json().complete, false);
  assert.equal(list.json().issues.length, 1); assert.match(list.json().issues[0].message, /2 files/);
  assert.equal(list.stderr.split('\n').filter(Boolean).length, 1);
  const healthy = await cli('sections', 'healthy.md', '--json');
  assert.equal(healthy.code, 0); assert.deepEqual(healthy.json(), { complete: true, file: 'healthy.md', sections: [{ title: 'Healthy' }] });
  assert.equal(healthy.stderr, '');
  const detailed = await cli('sections', 'healthy.md', '--debug');
  assert.equal(detailed.code, 1); assert.equal(detailed.json().complete, false);
  assert.ok(detailed.json().diagnostics.some((issue: any) => issue.file === 'broken.md'));
  assert.match(detailed.stderr, /unknown role/);
  const bad = await cli('sections', 'broken.md', '--json');
  assert.equal(bad.code, 1); assert.deepEqual(bad.json().issues, [{ file: 'broken.md', message: 'Some content could not be fully indexed. Results may be partial.' }]);
  const goodRead = await cli('read-section', 'mixed.md', '--title', 'Good', '--json');
  assert.equal(goodRead.code, 0); assert.equal(goodRead.json().complete, true); assert.equal(goodRead.stderr, '');
  const badRead = await cli('read-section', 'mixed.md', '--title', 'Broken', '--json');
  assert.equal(badRead.code, 1); assert.equal(badRead.json().complete, false); assert.equal(badRead.json().issues.length, 1);
  assert.match(badRead.json().content, /\{unknown\}/);
  const term = await cli('read-term', 'AST', '--file', 'mixed.md', '--json');
  assert.equal(term.code, 0); assert.equal(term.json().complete, true);
  assert.equal((await cli('read-term', 'AST', '--json')).code, 1); // Global name lookup may miss another definition in a broken document.
  const batch = await cli('read', '--id', 'mixed.md#term-ast', '--id', 'missing', '--json');
  assert.equal(batch.code, 1); assert.equal(batch.json().complete, false);
  assert.equal(batch.json().items[0].content, 'AST\n: Tree.\n'); assert.equal(batch.json().items[1].error.code, 'itemNotFound');
  const query = { command: 'sections' as const, arguments: { file: 'healthy.md' } };
  const raw = await new IndexService(root).execute(query);
  assert.equal(raw.complete, false); assert.ok(raw.diagnostics!.length > 1);
  assert.deepEqual(presentResult(raw, query), healthy.json());
});
