import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import mark from 'markdown-it-mark';
import { installFootnotes } from './footnotes';
import { parseWiki } from './references';

const calloutTypes: Record<string, string> = {
  abstract: 'abstract', summary: 'abstract', tldr: 'abstract', info: 'info', todo: 'todo',
  tip: 'tip', hint: 'tip', important: 'tip', success: 'success', check: 'success', done: 'success',
  question: 'question', help: 'question', faq: 'question', warning: 'warning', caution: 'warning', attention: 'warning',
  failure: 'failure', fail: 'failure', missing: 'failure', danger: 'danger', error: 'danger',
  bug: 'bug', example: 'example', quote: 'quote', cite: 'quote', note: 'note'
};
const colors: Record<string, string> = { '🔴': 'red', '🟠': 'orange', '🟡': 'yellow', '🟢': 'green', '🔵': 'blue', '🟣': 'purple' };

/** Syntax only: shared by preview, indexing, and explicit expansion; never reads files. */
export function installObsidianSyntax(md: MarkdownIt, myst = false): void {
  const TokenClass = md.parseInline('', {})[0].constructor as typeof Token;
  installFootnotes(md, myst);
  md.use(mark);
  // Markdown Extended's kbd rule also consumes [[...]] before `link`.
  // Claim wiki syntax earlier, regardless of extension registration order.
  md.inline.ruler.before('escape', 'obsidian_wiki', (state, silent) => {
    if ((state as typeof state & { linkLevel: number }).linkLevel > 0) return false;
    const rest = state.src.slice(state.pos);
    const match = /^(?:!)?\[\[([^\]\n]+)\]\]/.exec(rest);
    if (!match) return false;
    const reference = parseWiki(match[0]);
    if (!reference) return false;
    if (!silent) {
      const token = state.push(match[0].startsWith('!') ? 'obsidian_embed' : 'obsidian_wiki', '', 0);
      token.meta = { ...token.meta, ...reference };
      const label = new TokenClass('text', '', 0);
      label.content = reference.label ?? reference.target.replace(/\.md$/i, '') + (reference.fragment ? ` › ${reference.fragment.replace(/^\^/, '')}` : '');
      token.children = [label];
    }
    state.pos += match[0].length;
    return true;
  });
  md.block.ruler.before('paragraph', 'obsidian_embed_block', (state, startLine, _endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trim();
    if (!/^!\[\[[^\]\n]+\]\]$/.test(line)) return false;
    const reference = parseWiki(line);
    if (!reference) return false;
    if (!silent) {
      const token = state.push('obsidian_embed_block', '', 0);
      token.meta = { ...token.meta, ...reference };
      token.map = [startLine, startLine + 1];
      token.block = true;
      state.line = startLine + 1;
    }
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.inline.ruler.before('text', 'obsidian_comment', (state, silent) => {
    if (!state.src.startsWith('%%', state.pos)) return false;
    const end = state.src.indexOf('%%', state.pos + 2);
    if (end < 0) return false;
    if (!silent) state.push('obsidian_comment', '', 0);
    state.pos = end + 2;
    return true;
  });
  md.block.ruler.before(myst ? 'myst_line_comment' : 'blockquote', 'obsidian_comment_block', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    if (!state.src.startsWith('%%', start)) return false;
    const end = state.src.indexOf('%%', start + 2);
    if (end < 0) return false;
    let closingLine = startLine;
    while (closingLine < endLine && state.eMarks[closingLine] < end + 2) closingLine++;
    if (closingLine >= endLine || state.src.slice(end + 2, state.eMarks[closingLine]).trim()) return false;
    if (!silent) state.line = closingLine + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

  // Transform callout structure before inline parsing, keeping title/body syntax intact.
  md.core.ruler.after('block', 'obsidian_callouts', state => {
    for (let index = 0; index < state.tokens.length; index++) {
      const open = state.tokens[index];
      const paragraph = state.tokens[index + 1];
      const inline = state.tokens[index + 2];
      if (open.type !== 'blockquote_open' || paragraph?.type !== 'paragraph_open' || inline?.type !== 'inline') continue;
      const firstLineEnd = inline.content.indexOf('\n');
      const firstLine = firstLineEnd < 0 ? inline.content : inline.content.slice(0, firstLineEnd);
      const marker = /^\[!([\w-]+)\]([+-])?(?:[ \t]+(.*))?$/.exec(firstLine);
      if (!marker) continue;
      let depth = 1;
      let close: Token | undefined;
      for (let cursor = index + 1; cursor < state.tokens.length; cursor++) {
        if (state.tokens[cursor].type === 'blockquote_open') depth++;
        if (state.tokens[cursor].type === 'blockquote_close' && --depth === 0) { close = state.tokens[cursor]; break; }
      }
      if (!close) continue;
      const identifier = marker[1].toLowerCase();
      const metadata = { identifier, type: calloutTypes[identifier] ?? 'note', fold: marker[2] ?? '' };
      open.type = 'obsidian_callout_open'; open.meta = metadata;
      close.type = 'obsidian_callout_close'; close.meta = metadata;
      const titleOpen = new TokenClass('obsidian_callout_title_open', '', 1);
      const title = new TokenClass('inline', '', 0);
      const titleClose = new TokenClass('obsidian_callout_title_close', '', -1);
      titleOpen.meta = titleClose.meta = metadata;
      title.content = marker[3] ?? identifier.charAt(0).toUpperCase() + identifier.slice(1);
      title.children = [];
      title.map = inline.map ? [inline.map[0], inline.map[0] + 1] : null;
      const body = firstLineEnd < 0 ? '' : inline.content.slice(firstLineEnd + 1);
      const replacement = [titleOpen, title, titleClose];
      if (body) {
        inline.content = body;
        if (inline.map) inline.map = [inline.map[0] + 1, inline.map[1]];
        replacement.push(paragraph, inline, state.tokens[index + 3]);
      }
      state.tokens.splice(index + 1, 3, ...replacement);
    }
  });
  md.inline.ruler.before('text', 'obsidian_tag', (state, silent) => {
    if (state.src[state.pos] !== '#' || (state as typeof state & { linkLevel: number }).linkLevel > 0) return false;
    if (state.pos > 0 && !/[\s([{]/.test(state.src[state.pos - 1])) return false;
    const match = /^#([\p{L}\p{M}\p{N}\p{Extended_Pictographic}\uFE0F\u200D_/-]+)/u.exec(state.src.slice(state.pos));
    if (!match || !/[^\p{N}]/u.test(match[1]) || match[1].endsWith('/')) return false;
    if (!silent) { const token = state.push('obsidian_tag', 'span', 0); token.content = match[0]; }
    state.pos += match[0].length;
    return true;
  });
  md.core.ruler.push('obsidian_blocks', state => {
    const tokens = state.tokens;
    const ancestors: Token[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.nesting === 1) ancestors.push(token);
      if (token.nesting === -1) ancestors.pop();
      if (token.type !== 'inline' || !token.children) continue;
      const children = token.children;
      for (let cursor = 0; cursor < children.length - 1; cursor++) {
        if (children[cursor].type !== 'mark_open' || children[cursor + 1].type !== 'text') continue;
        for (const [emoji, color] of Object.entries(colors)) {
          if (children[cursor + 1].content.startsWith(emoji)) {
            children[cursor].attrSet('data-highlight', color);
            children[cursor + 1].content = children[cursor + 1].content.slice(emoji.length);
            break;
          }
        }
      }
      const itemOpen = ancestors.findLast(item => item.type === 'list_item_open');
      const first = children[0];
      const task = first?.type === 'text' ? /^\[([^\]\n])\][ \t]+/.exec(first.content) : undefined;
      if (task && itemOpen && tokens[index - 1]?.type === 'paragraph_open') {
        first.content = first.content.slice(task[0].length);
        const checkbox = new TokenClass('obsidian_checkbox', 'input', 0);
        checkbox.meta = { checked: task[1] !== ' ', marker: task[1] };
        children.unshift(checkbox);
        itemOpen.attrJoin('class', 'obsidian-task');
        itemOpen.attrSet('data-task', task[1]);
      }

      const last = children.at(-1);
      if (last?.type !== 'text') continue;
      const standalone = /^\^([a-zA-Z0-9-]+)$/.exec(token.content.trim());
      const trailing = /[ \t]+\^([a-zA-Z0-9-]+)[ \t]*$/.exec(last.content);
      if (!standalone && !trailing) continue;
      let block: Token | undefined;
      if (standalone && tokens[index - 1]?.type === 'paragraph_open' && tokens[index + 1]?.type === 'paragraph_close') {
        const previous = tokens[index - 2];
        if (!previous || previous.type === 'inline') continue;
        if (previous.nesting === -1) {
          let depth = 1;
          for (let cursor = index - 3; cursor >= 0; cursor--) {
            depth -= tokens[cursor].nesting;
            if (depth === 0) { block = tokens[cursor]; break; }
          }
        } else block = previous;
        if (!block?.map) continue;
        tokens[index - 1].hidden = token.hidden = tokens[index + 1].hidden = true;
        token.children = [];
      } else {
        block = itemOpen ?? tokens[index - 1];
        if (!block?.map || !trailing) continue;
        last.content = last.content.slice(0, trailing.index);
        token.content = token.content.replace(/[ \t]+\^[a-zA-Z0-9-]+[ \t]*$/, '');
      }
      const id = (standalone ?? trailing)![1];
      block.attrSet('id', `obsidian-block-${id}`);
      block.attrSet('data-obsidian-block', id);
      block.meta = {
        ...block.meta, obsidianBlockRange: [...block.map!],
        obsidianBlockMarker: { map: token.map ? [...token.map] : undefined, standalone: !!standalone }
      };
    }
  });
}
