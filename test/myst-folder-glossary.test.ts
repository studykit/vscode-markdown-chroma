import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GenericParent } from 'myst-common';
import { VFile } from 'vfile';
import { createMystFolderGlossary } from '../src/myst-folder-glossary';

const config = 'version: 1\nglossaries:\n  - include: "Terms/**/*.md"\n    definitionHeading: Meaning\n';
const tree = (): GenericParent => ({
  type: 'root',
  children: [{
    type: 'block',
    children: [
      { type: 'heading', depth: 2, position: { start: { line: 5, column: 1 }, end: { line: 5, column: 11 } },
        children: [{ type: 'text', value: 'Meaning' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'A conversation.' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'Further context.' }] },
    ],
  }],
});

test('the MyST entry point uses the Chroma folder rule and canonical alias handling', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'chroma-myst-glossary-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'book');
  const folder = join(root, 'Terms', 'chat');
  await mkdir(folder, { recursive: true });
  await writeFile(join(root, 'chroma.index.yml'), config);
  const source = '---\naliases: [채팅방, Room, room, chat]\n---\n## Meaning\n\nA conversation.\n';
  const file = join(folder, 'chat.md');
  await writeFile(file, source);
  const plugin = createMystFolderGlossary({ root });
  const spec = plugin.transforms?.[0];
  assert.equal(spec?.stage, 'document');
  assert.ok(spec);
  // MyST invokes the unified plugin factory before calling its document transform.
  const transform = Reflect.apply(spec.plugin, undefined, [undefined, {}]);
  const document = tree();
  transform(document, new VFile({ path: file }));

  const content = document.children[0].children!;
  assert.equal(content[0].type, 'heading');
  assert.deepEqual(content[1].children?.[0].children, [
    { type: 'definitionTerm', children: [{ type: 'text', value: 'chat' }] },
    { type: 'definitionDescription', children: [{ type: 'text', value: 'A conversation.' }] },
  ]);
  assert.deepEqual(content[2].children?.flatMap(node => node.indexEntries ?? []), [
    { entry: '채팅방' }, { entry: 'Room' },
  ]);
  assert.deepEqual(content[3], tree().children[0].children?.[2]);

  const outside = join(scratch, 'Terms', 'chat.md');
  const ignored = tree();
  transform(ignored, new VFile({ path: outside }));
  assert.deepEqual(ignored, tree());
  const link = join(folder, 'link.md');
  await symlink(file, link);
  assert.throws(() => transform(tree(), new VFile({ path: link })), /regular project file/);
});
