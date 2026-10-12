import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import GithubSlugger from 'github-slugger';
import type { WikiReference } from './types';

export function parseWiki(raw: string): WikiReference | undefined {
  const match = /^(?:!)?\[\[([^\n]+)\]\]$/.exec(raw);
  if (!match) return;
  // Table parsers differ: markdown-it removes the escaped pipe's backslash,
  // while Markdown Extended's multimd table preserves it for inline parsing.
  const body = match[1].replace(/\\\|/g, '|');
  const separator = body.indexOf('|');
  const destination = (separator < 0 ? body : body.slice(0, separator)).trim();
  const hash = destination.indexOf('#');
  const target = hash < 0 ? destination : destination.slice(0, hash);
  const fragment = hash < 0 ? '' : destination.slice(hash + 1);
  if (!target && !fragment) return;
  return {
    target, fragment, raw,
    label: separator < 0 ? undefined : body.slice(separator + 1).trim()
  };
}

export function plainText(token: Token): string {
  if (token.children) return token.children.map(plainText).join('');
  return ['text', 'code_inline', 'emoji'].includes(token.type) ? token.content : '';
}

export interface Section {
  start: number;
  end: number;
  anchor: string;
}

/** Parse real Markdown blocks so headings/IDs inside code never become targets. */
export function findSection(md: MarkdownIt, source: string, fragment: string): Section | undefined {
  const tokens: Token[] = md.parse(source, {}).flatMap(token => token.type === 'myst_document' ? token.meta.referenceTokens() : [token]);
  if (fragment.startsWith('^')) {
    const id = fragment.slice(1);
    const token = tokens.find(item => item.attrGet('data-obsidian-block') === id);
    const range: [number, number] | undefined = token?.meta?.obsidianBlockRange ?? token?.map;
    return range ? { start: range[0], end: range[1], anchor: `obsidian-block-${id}` } : undefined;
  }
  const slugger = new GithubSlugger();
  const parents: { level: number; title: string }[] = [];
  const headings: { start: number; level: number; title: string; trail: string; anchor: string }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'heading_open' || !token.map) continue;
    const title = plainText(tokens[index + 1]);
    const level = Number(token.tag.slice(1));
    while (parents.length && parents.at(-1)!.level >= level) parents.pop();
    parents.push({ level, title });
    headings.push({ start: token.map[0], level, title, trail: parents.map(item => item.title).join('#'), anchor: slugger.slug(title) });
  }
  const normalized = fragment.normalize('NFC').toLocaleLowerCase();
  const index = headings.findIndex(heading =>
    (fragment.includes('#') ? heading.trail : heading.title).normalize('NFC').toLocaleLowerCase() === normalized
    || heading.anchor === fragment);
  if (index < 0) return;
  const heading = headings[index];
  const next = headings.slice(index + 1).find(candidate => candidate.level <= heading.level);
  return { start: heading.start, end: next?.start ?? source.split('\n').length, anchor: heading.anchor };
}

export function sectionSource(source: string, section: Section, md?: MarkdownIt): string {
  const lines = source.split('\n');
  let selected = lines.slice(section.start, section.end).join('\n');
  if (!md) return selected;
  // Definitions often live at the end of a note, outside an embedded section.
  const tokens: Token[] = [];
  const env: { references?: Record<string, { href: string; title: string }> } = {};
  md.block.parse(source, md, env, tokens);
  for (const token of tokens) {
    if (token.type === 'obsidian_footnote_definition' && token.map && (token.map[0] < section.start || token.map[1] > section.end)) {
      selected += '\n\n' + lines.slice(token.map[0], token.map[1]).join('\n');
    }
  }
  for (const [label, reference] of Object.entries(env.references ?? {})) {
    const href = reference.href.replace(/>/g, '%3E');
    const title = reference.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    selected += `\n\n[${label}]: <${href}>${title ? ` "${title}"` : ''}`;
  }
  return selected;
}
