import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { applyDirectives, applyRoles, createTokenizer, defaultOptions, tokensToMyst, type TokenHandlerSpec } from 'myst-parser';
import { VFile } from 'vfile';
import { installObsidianSyntax } from './obsidian-syntax';
import { previewMystOptions } from './myst-options';
import { plainText } from './references';
import { trackSourcePositions } from './source-positions';

export type MarkdownParseOptions = NonNullable<Parameters<typeof createTokenizer>[0]>;
const tokenAttrs = (token: Token) => ({ _token: token });
const leaf = (type: string): TokenHandlerSpec => ({ type, noCloseToken: true, isLeaf: true, getAttrs: token => ({ ...tokenAttrs(token), value: plainText(token) || token.content }) });
const handlers: Record<string, TokenHandlerSpec> = {
  obsidian_wiki: leaf('obsidianInline'),
  obsidian_embed: leaf('obsidianInline'),
  obsidian_embed_block: leaf('obsidianBlock'),
  obsidian_tag: leaf('obsidianInline'),
  obsidian_checkbox: leaf('obsidianInline'),
  obsidian_comment: { type: '_remove', noCloseToken: true },
  obsidian_callout: { type: 'obsidianCallout', getAttrs: tokenAttrs },
  obsidian_callout_title: { type: 'obsidianCalloutTitle', getAttrs: tokenAttrs },
  mark: { type: 'mark', getAttrs: token => ({ color: token.attrGet('data-highlight') }) },
  obsidian_footnotes: { type: '_lift' },
  obsidian_footnote: { type: 'footnoteDefinition', getAttrs: token => ({ identifier: token.meta.entry.label }) },
  obsidian_footnote_reference: { type: 'footnoteReference', noCloseToken: true, isLeaf: true, getAttrs: token => ({ identifier: token.meta.entry.label }) },
  obsidian_footnote_backlinks: { type: '_remove', noCloseToken: true },
  obsidian_footnote_definition: { type: '_remove', noCloseToken: true },
  list_item: { type: 'listItem', getAttrs: token => ({ spread: true, task: token.attrGet('data-task') }) }
};

function attachBlockRanges(tree: any, tokens: Token[]): void {
  const types: Record<string, string> = {
    paragraph_open: 'paragraph', heading_open: 'heading', list_item_open: 'listItem',
    bullet_list_open: 'list', ordered_list_open: 'list', blockquote_open: 'blockquote',
    obsidian_callout_open: 'obsidianCallout', table_open: 'table', fence: 'code', code_block: 'code'
  };
  const nodes: any[] = [];
  const visit = (node: any) => { nodes.push(node); node.children?.forEach(visit); };
  visit(tree);
  for (const token of tokens) {
    const id = token.attrGet('data-obsidian-block');
    if (!id || !token.map || !types[token.type]) continue;
    const node = nodes.find(node => node.type === types[token.type] && node.position?.start.line === token.map![0] + 1);
    if (node) node._obsidianBlock = { id, startLine: token.map[0] + 1, endLine: token.map[1] };
  }
}

/** Shared syntax only. Constructing/tokenizing never reads files or runs directives. */
export function createMarkdownTokenizer(options: MarkdownParseOptions = {}): MarkdownIt {
  const vfile = options.vfile ?? new VFile();
  const settings: MarkdownParseOptions = {
    ...previewMystOptions, ...options,
    markdownit: { linkify: true, ...options.markdownit },
    extensions: { ...previewMystOptions.extensions, smartquotes: false, tasklist: false, ...options.extensions },
    vfile
  };
  const md = createTokenizer(settings) as unknown as MarkdownIt;
  installObsidianSyntax(md, true);
  // MyST comments consume a whole line; %% comments must leave trailing prose.
  md.block.ruler.at('myst_line_comment', (state, start, _end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false;
    const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
    if (!line.startsWith('%') || line.startsWith('%%')) return false;
    if (!silent) state.line = start + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  const validateLink = md.validateLink;
  md.validateLink = url => /^file:/i.test(url) || validateLink(url);
  return md;
}

export function tokenizeMarkdown(source: string, options: MarkdownParseOptions = {}) {
  const md = createMarkdownTokenizer(options);
  trackSourcePositions(md, source);
  const tokens = md.parse(source, { vfile: options.vfile ?? new VFile() });
  // MyST hides tight paragraphs in tokens, but its AST must retain their
  // grouping for footnotes and directive bodies. Hidden block-ID markers stay hidden.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'paragraph_open' && tokens[i + 1]?.type === 'inline' && !tokens[i + 1].hidden) {
      tokens[i].hidden = false;
      if (tokens[i + 2]?.type === 'paragraph_close') tokens[i + 2].hidden = false;
    }
  }
  const tree = tokensToMyst(source, tokens as never, { ...options.mdast, handlers: { ...handlers, ...options.mdast?.handlers } });
  attachBlockRanges(tree, tokens);
  return { tree, tokens };
}

/** Expand only caller-supplied directive/role specs. Index callers supply built-ins
 * only; plugin callers retain their separate trust and selected-subtree gates. */
export function parseMarkdown(source: string, options: MarkdownParseOptions = {}) {
  const vfile = options.vfile ?? new VFile();
  const settings = { ...previewMystOptions, ...options, vfile };
  const { tree, tokens } = tokenizeMarkdown(source, settings);
  applyDirectives(tree, [...defaultOptions.directives, ...(settings.directives ?? [])], vfile, {
    parseMyst: (body, offset = 0) => {
      const parsed = parseMarkdown(body, settings).tree;
      const shift = (node: any) => {
        if (node.position) { node.position.start.line += offset; node.position.end.line += offset; }
        node.children?.forEach(shift);
      };
      shift(parsed);
      return parsed;
    }
  });
  applyRoles(tree, [...defaultOptions.roles, ...(settings.roles ?? [])], vfile);
  return { tree, tokens };
}
