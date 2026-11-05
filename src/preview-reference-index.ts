import { basicTransformations, glossaryTransform } from 'myst-transforms';
import { isTargetIdentifierNode } from 'myst-common';
import { VFile } from 'vfile';
import { parseMarkdown } from './markdown-parser';
import { parseFrontmatter } from './frontmatter';
import { normalizeGlossaries } from './glossary';

/** Static target inventory only: no includes, project plugins, or file reads. */
export function previewReferenceIdentifiers(source: string): Set<string> {
  const header = parseFrontmatter(source);
  const body = header ? source.split('\n').map((line, index) => index < header.endLine ? '' : line).join('\n') : source;
  const vfile = new VFile();
  const options = { vfile, markdownit: { linkify: false } };
  const tree = parseMarkdown(body, options).tree;
  normalizeGlossaries(tree, body, value => parseMarkdown(value, options).tree, vfile);
  basicTransformations(tree, vfile);
  glossaryTransform(tree, vfile);
  const identifiers = new Set<string>();
  const visit = (node: any) => {
    if (node.identifier && isTargetIdentifierNode(node)) identifiers.add(node.identifier);
    node.children?.forEach(visit);
  };
  visit(tree);
  return identifiers;
}
