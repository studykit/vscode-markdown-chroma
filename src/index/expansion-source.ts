import { createTokenizer, tokensToMyst } from 'myst-parser';
import { previewMystOptions } from '../myst-options';
import { IndexError } from './types';
import { parseFrontmatter } from '../frontmatter';

export interface ExpansionNode { type: string; children?: ExpansionNode[]; [key: string]: any }
export interface Occurrence { name: string; startLine: number; endLine: number; startOffset: number; endOffset: number; source: string; node: ExpansionNode }

/** Tokenization only: no callbacks, file access, or guessed fence boundaries. */
export function occurrences(source: string): Occurrence[] {
  const md = createTokenizer(previewMystOptions);
  md.inline.ruler.before('link', 'chroma_expand_embed', (state: any, silent: boolean) => {
    const match = /^!\[\[([^\]\n]+)\]\]/.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) { const token = state.push('chroma_expand_embed', '', 0); token.meta = { value: match[0], target: match[1].split('|')[0], offset: state.pos, source: state.src }; }
    state.pos += match[0].length; return true;
  });
  const originalLines = source.split('\n'), frontmatterEnd = parseFrontmatter(source)?.endLine ?? 0;
  const body = originalLines.map((line, i) => i < frontmatterEnd ? '' : line).join('\n');
  md.core.ruler.after('inline', 'chroma_embed_positions', (state: any) => {
    for (const token of state.tokens) if (token.type === 'inline' && token.map) for (const child of token.children ?? []) if (child.type === 'chroma_expand_embed') {
      const before = child.meta.source.slice(0, child.meta.offset), relativeLine = before.split('\n').length - 1;
      const line = token.map[0] + relativeLine, column = before.length - before.lastIndexOf('\n') - 1;
      const indent = Math.max(0, originalLines[line]?.indexOf(child.meta.source.split('\n')[relativeLine]) ?? 0);
      child.map = [line, line + 1]; child.col = [indent + column, indent + column + child.meta.value.length];
    }
  });
  const tree = tokensToMyst(body, md.parse(body, {}), { handlers: {
    chroma_expand_embed: { type: 'chromaEmbed', isLeaf: true, noCloseToken: true, getAttrs: (token: any) => token.meta },
  } }) as ExpansionNode;
  const result: Occurrence[] = [], lines = originalLines, offsets: number[] = [];
  let offset = 0; for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const walk = (node: ExpansionNode) => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'comment') return;
    if (node.type === 'mystDirective' || node.type === 'chromaEmbed') {
      const startLine = node.position?.start.line, endLine = node.position?.end.line;
      if (startLine && endLine) {
        const startOffset = offsets[startLine - 1] + (node.type === 'chromaEmbed' ? node.position.start.column - 1 : 0);
        const endOffset = node.type === 'chromaEmbed' ? startOffset + node.value.length : offsets[endLine - 1] + lines[endLine - 1].length;
        result.push({ name: node.name ?? 'obsidian-embed', startLine, endLine, startOffset, endOffset, source: source.slice(startOffset, endOffset), node });
      }
    }
    node.children?.forEach(walk);
  };
  walk(tree); return result;
}

export function selectOccurrence(source: string, line: number): Occurrence {
  const matches = occurrences(source).filter(item => item.startLine === line);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new IndexError('ambiguousDirective', 'Multiple occurrences start on this line. Select a source line with one occurrence.', matches.map(item => ({ name: item.name, line: item.startLine })));
  throw new IndexError('directiveNotFound', 'No directive or document embed starts on this line. Use its observed opening line.');
}

export const codeFence = (value: string, lang = '') => {
  const fence = '`'.repeat([...value.matchAll(/`+/g)].reduce((width, match) => Math.max(width, match[0].length + 1), 3));
  return `${fence}${lang}\n${value}${value.endsWith('\n') ? '' : '\n'}${fence}\n`;
};

/** Preserve content and structure, reporting unsupported nodes instead of dropping them. */
export function markdownFromAst(node: ExpansionNode, issue: (message: string) => void): string {
  const children = () => (node.children ?? []).map(child => markdownFromAst(child, issue)).join('');
  const block = (value: string) => value.trimEnd() + '\n\n';
  switch (node.type) {
    case 'root': case 'mystDirective': case 'block': case 'container': case 'div': case 'span':
    case 'admonition': case 'figure': case 'caption': case 'tabSet': case 'tabItem': case 'grid': case 'gridItem': return children();
    case 'text': return node.value ?? '';
    case 'mystRole': if (node.children) return children(); issue(`Role ${node.name} could not be expanded; original syntax retained.`); return `{${node.name}}\`${node.value ?? ''}\``;
    case 'paragraph': case 'admonitionTitle': return block(children());
    case 'heading': return block('#'.repeat(node.depth) + ' ' + children());
    case 'strong': return `**${children().trimEnd()}**`;
    case 'emphasis': return `*${children().trimEnd()}*`;
    case 'delete': return `~~${children().trimEnd()}~~`;
    case 'inlineCode': { const fence = '`'.repeat([...(node.value ?? '').matchAll(/`+/g)].reduce((width: number, m: any) => Math.max(width, m[0].length + 1), 1)); return `${fence} ${node.value ?? ''} ${fence}`; }
    case 'code': return block(codeFence(node.value ?? '', node.lang ?? ''));
    case 'inlineMath': return `$${node.value ?? ''}$`;
    case 'math': return block(`$$\n${node.value ?? ''}\n$$`);
    case 'link': return `[${children().trimEnd()}](${node.url ?? ''})`;
    case 'image': return block(`![${node.alt ?? ''}](${node.url ?? ''})`);
    case 'crossReference': return `[${children().trimEnd() || node.label || node.identifier || ''}](#${node.identifier ?? node.label ?? ''})`;
    case 'blockquote': return block(children().trimEnd().split('\n').map(line => '> ' + line).join('\n'));
    case 'list': return block((node.children ?? []).map((item, i) => {
      const content = markdownFromAst(item, issue).trimEnd(), marker = node.ordered ? `${(node.start ?? 1) + i}. ` : '- ';
      return marker + content.replace(/\n/g, '\n' + ' '.repeat(marker.length));
    }).join('\n'));
    case 'listItem': case 'definitionList': return children();
    case 'definitionTerm': return children().trimEnd() + '\n';
    case 'definitionDescription': return block(': ' + children().trimEnd().replace(/\n/g, '\n  '));
    case 'table': {
      const rows = (node.children ?? []).map(row => (row.children ?? []).map(cell => markdownFromAst(cell, issue).trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map(row => row.length));
      const render = (row: string[]) => '| ' + Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ') + ' |';
      return block([render(rows[0]), render(Array(width).fill('---')), ...rows.slice(1).map(render)].join('\n'));
    }
    case 'tableCell': return children();
    case 'break': return '\n';
    case 'thematicBreak': return '\n---\n\n';
    case 'comment': return '';
    case 'expansionSource': return node.value ?? '';
    case 'previewError': case 'mystDirectiveError': issue(node.value ?? node.message ?? 'Directive expansion failed.'); return block(node.value ?? node.message ?? '');
    default: issue(`Unsupported generated node: ${node.type}. Readable content has been retained.`); return (node.value ?? '') + children();
  }
}
