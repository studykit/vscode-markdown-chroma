import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenericNode, MystPlugin } from 'myst-common' with { 'resolution-mode': 'import' };
import {
  documentNodes, findFolderTerm, FOLDER_GLOSSARY_CONFIG, matchFolderGlossary, parseFolderGlossaryConfig,
} from './folder-glossary';
import { parseFrontmatter } from './frontmatter';

const maxDocumentBytes = 2 * 1024 * 1024;
const text = (value: string): GenericNode => ({ type: 'text', value });

function readProjectFile(file: string): string {
  const stat = lstatSync(file);
  if (!stat.isFile() || realpathSync(file) !== file || stat.size > maxDocumentBytes) {
    throw new Error(`Expected a regular project file within the 2 MiB limit: ${file}`);
  }
  return readFileSync(file, 'utf8');
}

function projectFile(root: string, file: string): string | undefined {
  const name = relative(root, file);
  if (isAbsolute(name) || name.split(sep).some(part => part.startsWith('.') || part === 'node_modules' || part === '_build')) return;
  return name.split(sep).join('/');
}

function indexedAliases(aliases: string[]): GenericNode {
  const children = [text('Also known as ')];
  for (const alias of aliases) {
    if (children.length > 1) children.push(text(', '));
    children.push({ type: 'span', children: [text(alias)], indexEntries: [{ entry: alias }] });
  }
  children.push(text('.'));
  return { type: 'paragraph', children };
}

export interface MystFolderGlossaryOptions {
  /** Project directory containing chroma.index.yml. */
  root: string | URL;
}

/** Project transform for MyST builds that use Chroma's file-based glossary. */
export function createMystFolderGlossary({ root }: MystFolderGlossaryOptions): MystPlugin {
  const requestedRoot = resolve(typeof root === 'string' ? root : fileURLToPath(root));
  const projectRoot = realpathSync(requestedRoot);
  const configPath = join(projectRoot, FOLDER_GLOSSARY_CONFIG);
  const config = parseFolderGlossaryConfig(
    lstatSync(configPath, { throwIfNoEntry: false }) ? readProjectFile(configPath) : undefined,
  );
  if (config.error) throw new Error(config.error);

  return {
    name: 'Markdown Chroma folder glossary',
    transforms: [{
      name: 'chroma-folder-glossary',
      stage: 'document',
      plugin: () => (tree, file) => {
        if (!file.path || !/\.(?:md|markdown)$/i.test(file.path)) return;
        const absolute = resolve(file.path);
        const name = projectFile(projectRoot, absolute) ?? projectFile(requestedRoot, absolute);
        if (!name) return;
        const match = matchFolderGlossary(config, name);
        if (match.error) file.fail(match.error);
        if (!match.heading) return;

        const frontmatter = parseFrontmatter(readProjectFile(join(projectRoot, name)));
        if (frontmatter?.error) file.fail(frontmatter.error);
        const result = findFolderTerm(tree, name, match.heading, frontmatter);
        if (result.error) file.fail(result.error);
        const term = result.term;
        if (!term) return;

        for (const parent of [tree, ...documentNodes(tree)]) {
          if (parent !== tree && parent.type !== 'block') continue;
          const siblings = parent.children;
          const heading = siblings?.findIndex(node => node.type === 'heading' && node.depth === 2 &&
            node.position?.start.line === term.headingLine) ?? -1;
          if (!siblings || heading === -1) continue;

          const first = siblings[heading + 1];
          const definition = first && first.type !== 'heading' && first.type !== 'block' ? first : undefined;
          const children = definition?.type === 'paragraph' ? definition.children ?? [] : definition ? [definition] : [];
          // The MyST glossary pass registers the injected term and assigns its anchor.
          const glossary: GenericNode = {
            type: 'glossary',
            children: [{
              type: 'definitionList',
              children: [
                { type: 'definitionTerm', children: [text(term.name)] },
                { type: 'definitionDescription', children },
              ],
            }],
          };
          siblings.splice(heading + 1, definition ? 1 : 0, glossary, ...(term.aliases.length ? [indexedAliases(term.aliases)] : []));
          return;
        }
      },
    }],
  };
}
