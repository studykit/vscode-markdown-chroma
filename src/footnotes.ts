import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

interface Definition {
  source: string;
  line: number;
}

interface Entry {
  source: string;
  line?: number;
  count: number;
}

interface Footnotes {
  definitions: Map<string, Definition>;
  entries: Entry[];
  labels: Map<string, number>;
}

interface Environment {
  obsidianFootnotes?: Footnotes;
  docId?: string;
  footnotes?: unknown;
}

const newFootnotes = (): Footnotes => ({ definitions: new Map(), entries: [], labels: new Map() });
const footnotesFor = (env: Environment): Footnotes => env.obsidianFootnotes ??= newFootnotes();

/** Obsidian reference and inline footnotes, with no separate footnote dependency. */
export function installFootnotes(md: MarkdownIt): void {
  md.core.ruler.before('block', 'obsidian_footnote_setup', state => {
    // Other Markdown extensions may register these rules after this extension.
    // Disable them at parse time so only one parser owns numbering and footers.
    md.block.ruler.disable('footnote_def', true);
    md.inline.ruler.disable(['footnote_inline', 'footnote_ref'], true);
    md.core.ruler.disable('footnote_tail', true);
    state.env.footnotes = undefined;
    state.env.obsidianFootnotes = newFootnotes();
  });

  md.block.ruler.before('reference', 'obsidian_footnote_definition', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const match = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/.exec(state.src.slice(start, state.eMarks[startLine]));
    if (!match) return false;
    if (silent) return true;
    const body = [match[2]];
    let nextLine = startLine + 1;
    while (nextLine < endLine) {
      if (state.isEmpty(nextLine)) {
        let nextContent = nextLine + 1;
        while (nextContent < endLine && state.isEmpty(nextContent)) nextContent++;
        if (nextContent >= endLine || state.sCount[nextContent] - state.blkIndent < 2) break;
        body.push('');
      } else {
        if (state.sCount[nextLine] - state.blkIndent < 2) break;
        body.push(state.getLines(nextLine, nextLine + 1, state.blkIndent + 2, false));
      }
      nextLine++;
    }
    const definition = { source: body.join('\n'), line: startLine };
    const notes = footnotesFor(state.env);
    if (!notes.definitions.has(match[1])) notes.definitions.set(match[1], definition);
    const token = state.push('obsidian_footnote_definition', '', 0);
    token.meta = { label: match[1] };
    token.map = [startLine, nextLine];
    token.block = true;
    state.line = nextLine;
    return true;
  }, { alt: ['paragraph', 'reference'] });
  md.renderer.rules.obsidian_footnote_definition = () => '';

  md.inline.ruler.before('link', 'obsidian_footnote_reference', (state, silent) => {
    if ((state as typeof state & { linkLevel: number }).linkLevel > 0) return false;
    const start = state.pos;
    const notes = footnotesFor(state.env);
    let label: string | undefined;
    let source: string | undefined;
    let end: number;
    if (state.src.startsWith('^[', start)) {
      const closing = md.helpers.parseLinkLabel(state, start + 1);
      if (closing < 0) return false;
      source = state.src.slice(start + 2, closing);
      end = closing + 1;
    } else {
      const match = /^\[\^([^\]\s]+)\]/.exec(state.src.slice(start));
      if (!match || !notes.definitions.has(match[1])) return false;
      label = match[1];
      end = start + match[0].length;
    }
    if (!silent) {
      let id = label === undefined ? undefined : notes.labels.get(label);
      if (id === undefined) {
        if (notes.entries.length >= 1000) return false;
        id = notes.entries.length;
        const definition = label === undefined ? undefined : notes.definitions.get(label);
        notes.entries.push({ source: source ?? definition!.source, line: definition?.line, count: 0 });
        if (label !== undefined) notes.labels.set(label, id);
      }
      const token = state.push('obsidian_footnote_reference', '', 0);
      token.meta = { id, subId: notes.entries[id].count++ };
    }
    state.pos = end;
    return true;
  });

  md.core.ruler.after('inline', 'obsidian_footnote_tail', state => {
    const notes = footnotesFor(state.env);
    state.tokens = state.tokens.filter(token => token.type !== 'obsidian_footnote_definition');
    if (!notes.entries.length) return;
    state.tokens.push(new state.Token('obsidian_footnotes_open', '', 1));
    for (let id = 0; id < notes.entries.length; id++) {
      const entry = notes.entries[id];
      const open = new state.Token('obsidian_footnote_open', '', 1);
      open.meta = { id };
      state.tokens.push(open);
      const body: Token[] = [];
      md.block.parse(entry.source, md, state.env, body);
      for (const token of body) {
        if (token.type === 'inline') {
          token.children = [];
          md.inline.parse(token.content, md, state.env, token.children);
        }
        if (token.map) token.map = entry.line === undefined ? null : [token.map[0] + entry.line, token.map[1] + entry.line];
      }
      state.tokens.push(...body.filter(token => token.type !== 'obsidian_footnote_definition'));
      state.tokens.push(new state.Token('obsidian_footnote_close', '', -1));
    }
    state.tokens.push(new state.Token('obsidian_footnotes_close', '', -1));
  });

  const escape = md.utils.escapeHtml;
  const anchor = (token: Token, env: Environment) => `${env.docId ? `-${env.docId}-` : ''}${token.meta.id + 1}`;
  md.renderer.rules.obsidian_footnote_reference = (tokens, index, _options, env: Environment) => {
    const token = tokens[index];
    const id = escape(anchor(token, env));
    const ref = id + (token.meta.subId ? `:${token.meta.subId}` : '');
    const number = token.meta.id + 1;
    return `<sup class="footnote-ref"><a href="#fn${id}" id="fnref${ref}" aria-label="각주 ${number}">${number}</a></sup>`;
  };
  md.renderer.rules.obsidian_footnotes_open = () => '<hr class="obsidian-footnotes-sep">\n<section class="footnotes obsidian-footnotes" aria-label="각주"><ol class="obsidian-footnotes-list">\n';
  md.renderer.rules.obsidian_footnotes_close = () => '</ol></section>\n';
  md.renderer.rules.obsidian_footnote_open = (tokens, index, _options, env: Environment) => {
    const token = tokens[index];
    const id = escape(anchor(token, env));
    const number = token.meta.id + 1;
    return `<li id="fn${id}" class="footnote-item"><a class="obsidian-footnote-number" href="#fnref${id}" aria-label="각주 ${number}의 본문으로 돌아가기">${number}.</a><div class="obsidian-footnote-content">`;
  };
  md.renderer.rules.obsidian_footnote_close = () => '</div></li>\n';
}
