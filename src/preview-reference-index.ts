import { basicTransformations, glossaryTransform } from 'myst-transforms';
import { isTargetIdentifierNode } from 'myst-common';
import { VFile } from 'vfile';
import { parseMarkdown } from './markdown-parser';
import { parseFrontmatter } from './frontmatter';
import { glossaryAliasTargets, normalizeGlossaries } from './glossary';
import { configuredTermDirectives, previewMystOptions } from './myst-options';
import { attachFolderTerm, findFolderTerm } from './folder-glossary';

/** Static target inventory only: no includes, project plugins, or file reads. */
export function previewReferenceIdentifiers(source: string, declarations?: unknown, folder?: { file: string; heading: string }): Set<string> {
  const header = parseFrontmatter(source);
  const body = header ? source.split('\n').map((line, index) => index < header.endLine ? '' : line).join('\n') : source;
  const vfile = new VFile();
  const options = { vfile, markdownit: { linkify: false },
    directives: [...previewMystOptions.directives, ...configuredTermDirectives(declarations)] };
  const tree = parseMarkdown(body, options).tree;
  const term = folder && findFolderTerm(tree, folder.file, folder.heading, header).term;
  normalizeGlossaries(tree, body, value => parseMarkdown(value, options).tree, vfile);
  basicTransformations(tree, vfile);
  glossaryTransform(tree, vfile);
  if (term) attachFolderTerm(tree, term);
  const identifiers = new Set(glossaryAliasTargets(tree).keys());
  const visit = (node: any) => {
    if (node.identifier && isTargetIdentifierNode(node)) identifiers.add(node.identifier);
    node.children?.forEach(visit);
  };
  visit(tree);
  return identifiers;
}
