import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fixture } from './helpers';
import { resolvePreviewRoot, isWithin } from '../src/vault';
import { parseFrontmatter } from '../src/frontmatter';

test('vault-relative, explicitly relative and extension-less paths resolve', async t => {
  const f = await fixture(t, { 'Main.md': '', 'sub/Note.md': '', 'sub/Other.md': '', 'image.svg': '<svg/>' });
  const source = path.join(f.root, 'sub/Note.md');
  assert.deepEqual(f.vault.resolve('sub/Other', source), { status: 'found', path: path.join(f.root, 'sub/Other.md') });
  assert.deepEqual(f.vault.resolve('../Main', source), { status: 'found', path: path.join(f.root, 'Main.md') });
  assert.equal(f.vault.resolve('image.svg', source).status, 'found');
  assert.equal(f.vault.resolve('', source).status, 'found');
});

test('traversal and symlink escapes cannot read outside the vault', async t => {
  const f = await fixture(t, { 'Main.md': '', 'inside.md': 'inside' });
  const outside = path.join(f.root, '..', `${path.basename(f.root)}-outside.md`);
  await fs.writeFile(outside, 'private outside contents');
  t.after(() => fs.rm(outside, { force: true }));
  await fs.symlink(outside, path.join(f.root, 'escape.md'));
  await f.vault.refresh();
  const source = path.join(f.root, 'Main.md');
  assert.equal(f.vault.resolve('../outside', source).status, 'outside');
  assert.equal(f.vault.resolve('escape', source).status, 'missing');
  assert.equal(f.vault.read(path.join(f.root, 'escape.md')), undefined);
  assert.equal(f.vault.read(outside), undefined);
  assert.equal(isWithin(f.root, `${f.root}-other/file`), false);
});

test('alias edits and renamed or deleted files update the index', async t => {
  const f = await fixture(t, { 'Main.md': '', 'Note.md': '---\naliases: [Old]\n---\nBody' });
  const source = path.join(f.root, 'Main.md');
  const note = path.join(f.root, 'Note.md');
  f.vault.updateAliases(note, '---\naliases: [New]\n---');
  assert.equal(f.vault.resolve('Old', source).status, 'missing');
  assert.equal(f.vault.resolve('New', source).status, 'found');
  await fs.rename(note, path.join(f.root, 'Renamed.md'));
  await f.vault.refresh();
  assert.equal(f.vault.resolve('Note', source).status, 'missing');
  assert.equal(f.vault.resolve('Renamed', source).status, 'found');
});

test('preview roots use the workspace or containing folder regardless of .obsidian directories', async t => {
  const f = await fixture(t, { 'vault/.obsidian/app.json': '{}', 'vault/sub/Note.md': '' });
  const source = path.join(f.root, 'vault/sub/Note.md');
  assert.equal(resolvePreviewRoot(source, f.root), f.root);
  assert.equal(resolvePreviewRoot(source), path.dirname(source));
});

test('configured preview roots must be existing directories inside the workspace containing the source', async t => {
  const f = await fixture(t, { 'notes/sub/Note.md': '', 'other/Note.md': '' });
  const source = path.join(f.root, 'notes/sub/Note.md');
  assert.equal(resolvePreviewRoot(source, f.root, 'notes'), path.join(f.root, 'notes'));
  assert.equal(resolvePreviewRoot(source, f.root, path.join(f.root, 'notes/sub')), path.join(f.root, 'notes/sub'));
  for (const configured of ['..', 'missing', 'other', 'notes/sub/Note.md']) {
    assert.equal(resolvePreviewRoot(source, f.root, configured), f.root);
  }
});

test('configured preview roots reject symlink escapes from the workspace', async t => {
  const f = await fixture(t, { 'Main.md': '' });
  const outside = await fs.mkdtemp(path.join(path.dirname(f.root), 'chroma-outside-root-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'Note.md'), 'outside');
  await fs.symlink(outside, path.join(f.root, 'linked'), 'dir');
  assert.equal(resolvePreviewRoot(path.join(f.root, 'linked/Note.md'), f.root, 'linked'), f.root);
});

test('large notes are linkable but are not synchronously read for embedding', async t => {
  const f = await fixture(t, { 'Main.md': '', 'Large.md': 'x'.repeat(2 * 1024 * 1024 + 1) });
  assert.equal(f.vault.resolve('Large', path.join(f.root, 'Main.md')).status, 'found');
  assert.equal(f.vault.read(path.join(f.root, 'Large.md')), undefined);
});

test('invalid YAML and excessive alias expansion fail without throwing', () => {
  assert.ok(parseFrontmatter('---\na: 1\na: 2\n---')?.error);
  assert.ok(parseFrontmatter('---\n- invalid\n---')?.error);
  const bomb = '---\na: &a [1, 2]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b]\nd: [*c, *c, *c, *c, *c, *c, *c, *c]\n---';
  assert.ok(parseFrontmatter(bomb)?.error);
});
