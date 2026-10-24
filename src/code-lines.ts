/** Split native highlighted HTML at newlines, balancing spans on every line. */
export function codeLines(html: string): string[] {
  const lines: string[] = [], open: string[] = [];
  let line = '';
  for (const [token] of html.matchAll(/<span\b[^>]*>|<\/span>|[^<]+|</g)) {
    if (token === '</span>') { open.pop(); line += token; continue; }
    if (token.startsWith('<span')) { open.push(token); line += token; continue; }
    token.split('\n').forEach((part, index) => {
      if (index) { lines.push(line + '</span>'.repeat(open.length)); line = open.join(''); }
      line += part;
    });
  }
  lines.push(line);
  return lines;
}

export function decorateCode(html: string, numbered: boolean, start: number, emphasized: number[]): string {
  if (!numbered && !emphasized.length) return html;
  return html.replace(/(<code\b[^>]*>)([\s\S]*?)(<\/code>)/, (_match, before, body, after) => {
    // The native renderer adds a trailing newline; it is not an extra code line.
    const trailing = body.endsWith('\n') ? '\n' : '';
    const lines = codeLines(trailing ? body.slice(0, -1) : body);
    return before + lines.map((line, i) => `<span class="myst-code-line${emphasized.includes(i + 1) ? ' is-emphasized' : ''}"${numbered ? ` data-line-number="${start + i}"` : ''}>${line}</span>`).join('\n') + trailing + after;
  });
}
