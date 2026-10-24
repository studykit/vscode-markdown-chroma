import { tokenizeMarkdown } from '../markdown-parser';
import { IndexError } from './types';
import { parseFrontmatter } from '../frontmatter';

export interface ExpansionNode { type: string; children?: ExpansionNode[]; [key: string]: any }
export interface Occurrence { name: string; startLine: number; endLine: number; startOffset: number; endOffset: number; source: string; node: ExpansionNode }

/** Tokenization only: no callbacks, file access, or guessed fence boundaries. */
export function occurrences(source: string): Occurrence[] {
  const originalLines = source.split('\n'), frontmatterEnd = parseFrontmatter(source)?.endLine ?? 0;
  const body = originalLines.map((line, i) => i < frontmatterEnd ? '' : line).join('\n');
  const embedHandler = { type: 'chromaEmbed', isLeaf: true, noCloseToken: true, getAttrs: (token: any) => ({
    value: token.meta.raw, target: token.meta.target + (!token.meta.fragment ? '' : '#' + token.meta.fragment), block: token.type === 'obsidian_embed_block'
  }) };
  const tree = tokenizeMarkdown(body, { mdast: { handlers: { obsidian_embed: embedHandler, obsidian_embed_block: embedHandler } } }).tree as ExpansionNode;
  const result: Occurrence[] = [], lines = originalLines, offsets: number[] = [];
  let offset = 0; for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const walk = (node: ExpansionNode) => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'comment') return;
    if (node.type === 'mystDirective' || node.type === 'chromaEmbed') {
      const startLine = node.position?.start.line, endLine = node.position?.end.line;
      if (startLine && endLine) {
        const startOffset = offsets[startLine - 1] + (node.type === 'chromaEmbed' ? node.block ? Math.max(0, lines[startLine - 1].indexOf(node.value)) : node.position.start.column - 1 : 0);
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
    case 'details': return block(children());
    case 'summary': case 'paragraph': case 'admonitionTitle': return block(children());
    case 'heading': return block('#'.repeat(node.depth) + ' ' + children());
    case 'strong': return `**${children().trimEnd()}**`;
    case 'emphasis': return `*${children().trimEnd()}*`;
    case 'chemicalFormula': return `{chem}\`${node.value ?? children()}\``;
    case 'smallcaps': case 'subscript': case 'superscript': case 'keyboard': {
      const role = { smallcaps: 'sc', subscript: 'sub', superscript: 'sup', keyboard: 'kbd' }[node.type];
      return `{${role}}\`${children()}\``;
    }
    case 'mark': return `==${({ red: '🔴', orange: '🟠', yellow: '🟡', green: '🟢', blue: '🔵', purple: '🟣' } as Record<string, string>)[node.color] ?? ''}${children()}==`;
    case 'obsidianInline': case 'obsidianBlock': {
      const token = node._token;
      if (token?.type === 'obsidian_checkbox') return `[${token.meta.marker}] `;
      const value = token?.meta?.raw ?? token?.content ?? node.value ?? '';
      return node.type === 'obsidianBlock' ? block(value) : value;
    }
    case 'obsidianCallout': {
      const meta = node._token?.meta ?? {};
      return block(`[!${meta.identifier ?? 'note'}]${meta.fold ?? ''} ${children().trimEnd()}`.split('\n').map(line => '> ' + line).join('\n'));
    }
    case 'obsidianCalloutTitle': return block(children());
    case 'footnoteReference': return `[^${node.identifier}]`;
    case 'footnoteDefinition': return block(`[^${node.identifier}]: ${children().trimEnd().replace(/\n/g, '\n    ')}`);
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
