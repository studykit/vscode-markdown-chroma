import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import MarkdownIt from 'markdown-it';
import { FileVault } from '../src/vault';
import { extendObsidianMarkdown } from '../src/markdown';
import type { PreviewHost, RenderEnvironment } from '../src/types';

export async function fixture(t: TestContext, files: Record<string, string>, dirty = new Map<string, string>()) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'obsidian-markdown-unit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  const vault = new FileVault(root, file => dirty.get(file));
  await vault.refresh();
  const settings = { maxEmbedDepth: 5 };
  const host: PreviewHost = {
    resolve: (target, source) => vault.resolve(target, source),
    read: file => vault.read(file),
    documentUri: file => ({ fsPath: file, scheme: 'file' }),
    resourceUri: file => pathToFileURL(file).href,
    settings: () => settings
  };
  const md = extendObsidianMarkdown(new MarkdownIt({ html: true }), host);
  const environment = (name = 'Main.md'): RenderEnvironment => ({ currentDocument: { fsPath: path.join(root, name) }, containingImages: new Set() });
  const render = (source: string, name = 'Main.md') => md.render(source, environment(name));
  return { root, vault, md, host, settings, render, environment, dirty };
}
