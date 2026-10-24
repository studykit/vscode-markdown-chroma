import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { applyDirectives, applyRoles, createTokenizer, defaultOptions, tokensToMyst, type TokenHandlerSpec } from 'myst-parser';
import { VFile } from 'vfile';
import { installObsidianSyntax } from './obsidian-syntax';
import { previewMystOptions } from './myst-options';
import { plainText } from './references';

type Options = NonNullable<Parameters<typeof createTokenizer>[0]>;
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

/** One MyST tokenizer, including Obsidian syntax, for every preview and plugin body.
 * The pinned export-only patch exposes upstream's unchanged directive/role passes.
 * This module parses only; filesystem resolution remains in the preview host. */
export function parsePreview(source: string, options: Options = {}) {
  const vfile = options.vfile ?? new VFile();
  const settings: Options = {
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
  const tokens = md.parse(source, { vfile });
  // MyST hides tight paragraphs in tokens, but its AST must retain their
  // grouping for footnotes and directive bodies. Hidden block-ID markers stay hidden.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'paragraph_open' && tokens[i + 1]?.type === 'inline' && !tokens[i + 1].hidden) {
      tokens[i].hidden = false;
      if (tokens[i + 2]?.type === 'paragraph_close') tokens[i + 2].hidden = false;
    }
  }
  const tree = tokensToMyst(source, tokens as never, { ...options.mdast, handlers: { ...options.mdast?.handlers, ...handlers } });
  applyDirectives(tree, [...defaultOptions.directives, ...(settings.directives ?? [])], vfile, {
    parseMyst: (body, offset = 0) => {
      const parsed = parsePreview(body, settings).tree;
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
