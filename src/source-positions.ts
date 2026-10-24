import type MarkdownIt from 'markdown-it';

/** Preserve occurrence locations before inline syntax loses its source spelling. */
export function trackSourcePositions(md: MarkdownIt, source: string): void {
  const sourceLines = source.split('\n');
  const positioned = new Set(['image', 'link_open', 'obsidian_wiki', 'obsidian_embed', 'obsidian_tag']);
  md.inline.ruler.before('obsidian_comment', 'chroma_cursor', (state: any, silent: boolean) => {
    if (silent) return false;
    state.chromaCursor = state.pos;
    if (!state.chromaPush) {
      state.chromaPush = state.push;
      state.push = function (type: string, tag: string, nesting: number) {
        const token = this.chromaPush(type, tag, nesting);
        if (positioned.has(type)) token.meta = { ...token.meta, chromaOffset: this.chromaCursor, chromaSource: this.src };
        return token;
      };
    }
    return false;
  });
  md.core.ruler.after('inline', 'chroma_positions', (state: any) => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.map) continue;
      for (const child of token.children ?? []) {
        if (child.meta?.chromaOffset === undefined) continue;
        const before = child.meta.chromaSource.slice(0, child.meta.chromaOffset);
        const relativeLine = before.split('\n').length - 1;
        const line = token.map[0] + relativeLine;
        const column = before.length - (before.lastIndexOf('\n') + 1);
        const inlineLine = child.meta.chromaSource.split('\n')[relativeLine];
        const indent = Math.max(0, (sourceLines[line] ?? '').indexOf(inlineLine));
        child.map = [line, line + 1]; child.col = [indent + column, indent + column];
      }
    }
  });
}
