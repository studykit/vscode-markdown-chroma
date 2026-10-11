import { createHash } from 'node:crypto';
import GithubSlugger from 'github-slugger';
import { createTokenizer, defaultOptions, mystParse, tokensToMyst } from 'myst-parser';
import { normalizeLabel } from 'myst-common';
import { glossaryTransform } from 'myst-transforms';
import { VFile } from 'vfile';
import { gridDirectives } from 'myst-ext-grid';
import { cardDirective } from 'myst-ext-card';
import { tabDirectives } from 'myst-ext-tabs';
import { proofDirective } from 'myst-ext-proof';
import { exerciseDirectives } from 'myst-ext-exercise';
import { buttonRole } from 'myst-ext-button';
import { parseFrontmatter } from '../frontmatter';
import { globalId, normalizeTag, type ContentItem, type DocumentIndex, type Reference, type Section, type Table, type Target } from './types';

interface Node { type: string; children?: Node[]; position?: { start: { line: number; column: number }; end: { line: number; column: number } }; [key: string]: any }
const directives = [...gridDirectives, cardDirective, ...tabDirectives, proofDirective, ...exerciseDirectives];
const directiveBodies = new Map([...defaultOptions.directives, ...directives].flatMap(spec => [spec.name, ...(spec.alias ?? [])].map(name => [name, spec.body?.type] as const)));
const layout = new Set(['grid', 'grid-item', 'grid-item-card', 'tab-set', 'tab-item', 'div']);
const ignored = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html', 'comment']);
const text = (node: Node): string => {
  if (node.type === 'image') return node.alt ?? '';
  if (node.type === 'obsidianReference') return node.display || node.target || node.fragment || '';
  if (node.type === 'obsidianTag') return `#${node.name}`;
  if (node.type === 'mystRole') return /^(.+?)\s*<[^<>]+>\s*$/.exec(node.value)?.[1] ?? node.value;
  return node.value ?? node.children?.map(text).join('') ?? '';
};
export const hash = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const termIdentifier = (name: string) => `term-${normalizeLabel(name)?.identifier ?? ''}`;
const labelIdentifier = (name: string) => normalizeLabel(name)?.identifier ?? name;
function all(node: Node, type: string): Node[] { return [...(node.type === type ? [node] : []), ...(node.children?.flatMap(child => all(child, type)) ?? [])]; }
/** MyST +++ blocks contain document-level headings; directive and quote headings remain local. */
function* documentNodes(node: Node): Generator<Node> {
  for (const child of node.children ?? []) {
    yield child;
    if (child.type === 'block') yield* documentNodes(child);
  }
}
function range(node: Node, fallback = { startLine: 1, endLine: 1 }) {
  return { startLine: node.position?.start.line ?? fallback.startLine, endLine: Math.max(node.position?.start.line ?? fallback.startLine, node.position?.end.line ?? fallback.endLine) };
}
function labelValues(node: Node): string[] {
  return [...new Set([node.label, node.options?.name, node.options?.label].filter((v): v is string => typeof v === 'string' && !!v))];
}
function linkLiteral(value: string): string {
  if (value.startsWith('<')) return value.slice(0, value.indexOf('>') + 1);
  const balanced = (start: number, open: string, close: string) => {
    let depth = 0;
    for (let i = start; i < value.length; i++) {
      if (value[i] === '\\') { i++; continue; }
      if (value[i] === open) depth++;
      if (value[i] === close && --depth === 0) return i + 1;
    }
    return value.length;
  };
  let end = balanced(0, '[', ']');
  if (value[end] === '(') end = balanced(end, '(', ')');
  else if (value[end] === '[') end = balanced(end, '[', ']');
  return value.slice(0, end);
}

/** Adds leaf tokens before Markdown can split the contents of a wiki link into emphasis/roles. */
function indexTokenizer(options: Parameters<typeof createTokenizer>[0], source: string) {
  const md = createTokenizer(options);
  const sourceLines = source.split('\n');
  md.inline.ruler.before('text', 'chroma_cursor', (state: any, silent: boolean) => {
    if (silent) return false;
    state.chromaCursor = state.pos;
    if (!state.chromaPush) {
      state.chromaPush = state.push;
      state.push = function (type: string, tag: string, nesting: number) {
        const token = this.chromaPush(type, tag, nesting);
        if (['image', 'link_open', 'chroma_wiki', 'chroma_tag'].includes(type)) {
          token.meta = { ...token.meta, chromaOffset: this.chromaCursor, chromaSource: this.src };
        }
        return token;
      };
    }
    return false;
  });
  md.inline.ruler.before('link', 'chroma_wiki', (state: any, silent: boolean) => {
    const match = /^(!)?\[\[([^\]\n]+)\]\]/.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) {
      const token = state.push('chroma_wiki', '', 0);
      const [destination, ...display] = match[2].split('|');
      const fragmentAt = destination.indexOf('#');
      token.meta = { ...token.meta, raw: match[0], target: (fragmentAt < 0 ? destination : destination.slice(0, fragmentAt)).trim(),
        fragment: fragmentAt < 0 ? null : destination.slice(fragmentAt + 1).trim(), embed: !!match[1], display: display.join('|') };
    }
    state.pos += match[0].length;
    return true;
  });
  md.inline.ruler.before('text', 'chroma_tag', (state: any, silent: boolean) => {
    if (state.src[state.pos] !== '#' || (state.pos && !/[\s([>]/u.test(state.src[state.pos - 1]))) return false;
    const match = /^#([\p{L}\p{N}\p{M}_-]+(?:\/[\p{L}\p{N}\p{M}_-]+)*)/u.exec(state.src.slice(state.pos));
    if (!match || !/[\p{L}\p{M}_-]/u.test(match[1])) return false;
    if (!silent) { const token = state.push('chroma_tag', '', 0); token.meta = { ...token.meta, name: match[1] }; }
    state.pos += match[0].length;
    return true;
  });
  // The upstream inline tokens often inherit the first line of a paragraph. Preserve each occurrence's line.
  md.core.ruler.after('inline', 'chroma_positions', (state: any) => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.map) continue;
      for (const child of token.children ?? []) {
        if (child.meta?.chromaOffset === undefined) continue;
        const before = child.meta.chromaSource.slice(0, child.meta.chromaOffset);
        const relativeLine = before.split('\n').length - 1;
        const line = token.map[0] + relativeLine;
        const inlineColumn = before.length - (before.lastIndexOf('\n') + 1);
        const inlineLine = child.meta.chromaSource.split('\n')[relativeLine];
        const originalLine = sourceLines[line] ?? '';
        const indent = Math.max(0, originalLine.indexOf(inlineLine));
        child.map = [line, line + 1]; child.col = [indent + inlineColumn, indent + inlineColumn];
      }
    }
  });
  return md;
}

export function parseIndex(file: string, source: string, settings: Record<string, any> = {}): DocumentIndex {
  const frontmatter = parseFrontmatter(source);
  const lines = source.split('\n');
  const lastLine = lines.length - (source.endsWith('\n') ? 1 : 0);
  const body = lines.map((line, i) => i < (frontmatter?.endLine ?? 0) ? '' : line.replace(/\r$/, '')).join('\n');
  const properties = JSON.parse(JSON.stringify(frontmatter?.values ?? {})) as Record<string, unknown>;
  const document: DocumentIndex = { file, sourceHash: hash(source), signature: '', configHash: '', properties,
    aliases: (Array.isArray(properties.aliases) ? properties.aliases : typeof properties.aliases === 'string' ? [properties.aliases] : []).filter((v): v is string => typeof v === 'string'),
    tags: [], sections: [], tables: [], images: [], glossaries: [], terms: [], targets: [], outgoing: [], diagnostics: [], bibliographyKeys: [] };
  if (frontmatter?.error) document.diagnostics.push({ code: 'invalidFrontmatter', message: frontmatter.error, file, line: 1, severity: 'error' });
  const vfile = new VFile({ path: file });
  const options = { directives, roles: [buttonRole], extensions: { frontmatter: false, strikethrough: true,
    math: settings.settings?.parser?.dollarmath === false ? { dollarmath: false, amsmath: true } : true }, vfile };
  const tree = mystParse(body, options) as Node;
  glossaryTransform(tree, vfile);
  const processedDirectives = new Map(all(tree, 'mystDirective').map(node => [`${node.position?.start.line}:${node.name}`, node]));
  const processedTerms = new Map(all(tree, 'definitionTerm').filter(node => node.identifier).map(node => [node.position?.start.line, node]));
  const md = indexTokenizer(options, body);
  const raw = tokensToMyst(body, md.parse(body, { vfile }), { handlers: {
    chroma_wiki: { type: 'obsidianReference', noCloseToken: true, isLeaf: true, getAttrs: (token: any) => token.meta },
    chroma_tag: { type: 'obsidianTag', noCloseToken: true, isLeaf: true, getAttrs: (token: any) => token.meta },
    link: { type: 'link', getAttrs: (token: any) => ({ url: token.attrGet('href'), chromaOffset: token.meta?.chromaOffset, chromaSource: token.meta?.chromaSource }) },
    image: { type: 'image', noCloseToken: true, isLeaf: true, getAttrs: (token: any) => ({ url: token.attrGet('src'), alt: token.content }) },
  } }) as Node;
  for (const message of vfile.messages) document.diagnostics.push({ code: 'mystSyntax', file, line: message.line ?? undefined, message: message.message, severity: message.fatal ? 'error' : 'warning' });
  document.diagnostics = document.diagnostics.filter((d, i, a) => a.findIndex(v => v.code === d.code && v.line === d.line && v.message === d.message) === i);
  const slugger = new GithubSlugger(); slugger.slug('preamble');
  let pending: Node[] = [];
  for (const node of documentNodes(raw)) {
    if (node.type === 'mystTarget') { pending.push(node); continue; }
    if (node.type === 'heading') {
      const title = text(node);
      const start = pending[0]?.position?.start.line ?? node.position?.start.line ?? 1;
      const section: Section = { id: slugger.slug(title) || slugger.slug('section'), title, level: node.depth,
        headingPath: [], labels: pending.map(n => n.label), startLine: start, endLine: lastLine, ownEndLine: lastLine };
      document.sections.push(section);
    }
    pending = [];
  }
  const bodyStart = (frontmatter?.endLine ?? 0) + 1;
  const preambleEnd = (document.sections[0]?.startLine ?? lastLine + 1) - 1;
  if (lines.slice(bodyStart - 1, preambleEnd).some(line => line.trim())) document.sections.unshift({
    id: 'preamble', title: '', level: 0, headingPath: [], labels: [], startLine: bodyStart, endLine: preambleEnd, ownEndLine: preambleEnd,
  });
  const ancestors: Section[] = [];
  document.sections.forEach((section, i, sections) => {
    if (section.id === 'preamble') return;
    while (ancestors.length && ancestors.at(-1)!.level >= section.level) ancestors.pop();
    section.headingPath = [...ancestors.map(s => s.title), section.title]; ancestors.push(section);
    const nextPeer = sections.slice(i + 1).find(s => s.level <= section.level);
    section.endLine = nextPeer ? nextPeer.startLine - 1 : lastLine;
    section.ownEndLine = sections[i + 1] ? sections[i + 1].startLine - 1 : lastLine;
  });
  const belonging = (line: number) => document.sections.filter(s => s.startLine <= line && s.endLine >= line).at(-1);
  const common = (node: Node, id: string, inherited?: ReturnType<typeof range>): ContentItem => {
    const bounds = range(node, inherited); const section = belonging(bounds.startLine);
    return { id, file, ...bounds, sectionId: section?.id ?? null, headingPath: section?.headingPath ?? [], labels: labelValues(node), sourceHash: document.sourceHash };
  };
  const addTarget = (label: string, kind: string, id: string | null, bounds: ReturnType<typeof range>, labelStart = bounds.startLine) => {
    const target: Target = { label, identifier: labelIdentifier(label), kind, id, ...bounds, startLine: labelStart, nodeStartLine: bounds.startLine };
    const existing = document.targets.find(t => t.identifier === target.identifier && t.nodeStartLine === target.nodeStartLine);
    if (!existing) document.targets.push(target);
    else { existing.startLine = Math.min(existing.startLine, labelStart); if (id) { existing.id = id; existing.kind = kind; } }
  };
  for (const section of document.sections) for (const label of section.labels) addTarget(label, 'section', section.id, section);
  for (const section of document.sections) {
    const implicit = normalizeLabel(section.title);
    if (section.level && !section.labels.length && implicit?.html_id) document.targets.push({
      label: section.title, identifier: implicit.html_id, kind: 'section', id: section.id, implicit: true,
      startLine: section.startLine, endLine: section.endLine, nodeStartLine: section.startLine,
    });
  }
  const addTag = (name: string) => {
    const normalized = normalizeTag(name);
    if (normalized && !document.tags.some(tag => tag.normalized === normalized)) document.tags.push({ name: name.replace(/^#/, ''), normalized });
  };
  (Array.isArray(properties.tags) ? properties.tags : typeof properties.tags === 'string' ? properties.tags.split(/[,\s]+/) : []).forEach(v => { if (typeof v === 'string') addTag(v); });
  const addReference = (node: Node, kind: Reference['kind'], target: string, fragment: string | null = null, original?: string) => {
    const bounds = range(node); const section = belonging(bounds.startLine);
    document.outgoing.push({ ...bounds, kind, syntax: node.type === 'obsidianReference' ? 'obsidian' : ['mystDirective', 'mystRole', 'cite'].includes(node.type) ? 'myst' : 'markdown', target, fragment, raw: original ?? sourceRaw(node), column: node.position?.start.column ?? 1,
      sectionId: section?.id ?? null, headingPath: section?.headingPath ?? [] });
  };
  const sourceRaw = (node: Node) => {
    const bounds = range(node); const column = node.position?.start.column ?? 1;
    if (node.type === 'mystRole' || node.type === 'cite') return lines[bounds.startLine - 1]?.slice(column - 1, node.position?.end.column ? node.position.end.column - 1 : undefined).replace(/\r$/, '') ?? '';
    if (node.chromaSource !== undefined && node.chromaOffset !== undefined) {
      const original = node.chromaSource.slice(node.chromaOffset);
      // Reference-style links and balanced destinations are left literal in the source record.
      return linkLiteral(original);
    }
    return lines.slice(bounds.startLine - 1, bounds.endLine).join('\n').replace(/\r/g, '');
  };
  const figureInfo = (node: Node) => ({ id: `figure-${range(node).startLine}`, labels: [...new Set([...labelValues(node), ...document.targets.filter(t => t.nodeStartLine === range(node).startLine).map(t => t.label)])],
    caption: node.value ? text({ type: 'root', children: (node.children?.[0]?.children ?? []).filter((c: Node) => c.type !== 'image' && c.type !== 'table' && !all(c, 'image').length && !all(c, 'table').length) }).trim() || null : null });
  const termSlugs = new GithubSlugger();
  const tableDeclarations: Node[] = [];
  const rawWalk = (node: Node, inherited?: ReturnType<typeof range>, figure: ReturnType<typeof figureInfo> | null = null) => {
    const bounds = range(node, inherited);
    node.position ??= { start: { line: bounds.startLine, column: 1 }, end: { line: bounds.endLine, column: 1 } };
    if (node.type === 'math') for (const label of labelValues(node)) addTarget(label, 'math', null, bounds);
    if (ignored.has(node.type)) return;
    if (node.type === 'mystTarget') {
      // Handled with the following semantic node, including non-section targets below.
      return;
    }
    if (node.type === 'obsidianTag') { addTag(node.name); return; }
    if (node.type === 'obsidianReference') {
      addReference(node, node.embed ? 'embed' : 'wiki', node.target, node.fragment, node.raw);
      if (node.embed && /\.(?:png|jpe?g|gif|svg|webp|avif|bmp|ico|tiff?)$/i.test(node.target)) document.images.push({
        ...common(node, `image-${document.images.length + 1}`), syntax: 'obsidian-embed', source: node.target, alt: node.display ?? '', figure,
      });
      return;
    }
    if (node.type === 'link') {
      const [target, ...fragments] = String(node.url).split('#');
      if (!text(node) && (!target || (!target.includes('/') && !target.includes('.') && !target.includes(':')))) addReference(node, 'ref', labelIdentifier(fragments.length ? fragments.join('#') : target));
      else addReference(node, 'link', target, fragments.length ? fragments.join('#') : null);
    }
    if (node.type === 'image') { document.images.push({ ...common(node, `image-${document.images.length + 1}`), syntax: 'markdown', source: node.url, alt: node.alt ?? '', figure }); return; }
    if (node.type === 'cite') { addReference(node, 'citation', node.identifier, null); return; }
    if (node.type === 'mystRole') {
      const target = /<([^<>]+)>\s*$/.exec(node.value)?.[1] ?? node.value;
      if (node.name === 'term') addReference(node, 'term', termIdentifier(target));
      else if (['ref', 'numref', 'eq'].includes(node.name)) addReference(node, 'ref', labelIdentifier(target));
      else if (node.name === 'doc') { const [fileTarget, ...fragment] = target.split('#'); addReference(node, 'doc', fileTarget, fragment.length ? fragment.join('#') : null); }
      else if (node.name.startsWith('cite')) for (const cited of target.split(',').map((value: string) => value.trim()).filter(Boolean)) addReference(node, 'citation', labelIdentifier(cited));
      return;
    }
    if (node.type === 'mystDirective') {
      if (['table', 'list-table', 'csv-table'].includes(node.name)) tableDeclarations.push(node);
      const processed = processedDirectives.get(`${node.position?.start.line}:${node.name}`);
      if (node.name === 'figure') figure = figureInfo(processed ?? node);
      if (['include', 'literalinclude', 'embed'].includes(node.name)) {
        const [target, ...fragment] = String(node.args ?? '').trim().split('#');
        addReference(node, node.name === 'embed' ? 'embed' : 'include', target, fragment.length ? fragment.join('#') : null);
      }
      if (node.name === 'glossary') {
        const localId = `glossary-${document.glossaries.length + 1}`;
        const item = { ...common(node, globalId(file, localId)), localId, name: node.args || null, termCount: 0 };
        document.glossaries.push(item);
        for (const list of node.children?.find(n => n.type === 'mystDirectiveBody')?.children?.filter(n => n.type === 'definitionList') ?? []) {
          const children = list.children ?? [];
          for (let i = 0; i < children.length; i++) {
            const term = children[i]; if (term.type !== 'definitionTerm') continue;
            const descriptions: Node[] = [];
            let firstDescription = i + 1;
            while (children[firstDescription]?.type === 'definitionTerm') firstDescription++;
            for (let j = firstDescription; j < children.length && children[j].type !== 'definitionTerm'; j++) if (children[j].type === 'definitionDescription') descriptions.push(children[j]);
            if (!descriptions.length) continue;
            const parsedTerm = processedTerms.get(range(term).startLine);
            const name = parsedTerm?.label ?? text(term).trim(); const identifier = parsedTerm?.identifier ?? termIdentifier(name);
            const id = termSlugs.slug(`term-${name}`) || termSlugs.slug('term');
            const next = children.slice(firstDescription).find(n => n.type === 'definitionTerm');
            let endLine = Math.min(next ? range(next).startLine - 1 : bounds.endLine - 1, Math.max(...descriptions.map(n => range(n).endLine)));
            while (endLine > range(term).startLine && !lines[endLine - 1]?.trim()) endLine--;
            document.terms.push({ ...common(term, globalId(file, id)), endLine, localId: id, identifier, name, glossaryId: item.id }); item.termCount++;
          }
        }
        for (const label of item.labels) addTarget(label, 'glossary', item.id, bounds);
      }
      if (node.name === 'image' || (node.name === 'figure' && node.args && !String(node.args).startsWith('#'))) {
        const images = processed ? all(processed, 'image').slice(0, 1) : [];
        for (const image of images) document.images.push({ ...common(node, `image-${document.images.length + 1}`), labels: node.name === 'image' ? labelValues(node) : labelValues(image),
          syntax: `myst-${node.name}`, source: image.url, alt: image.alt ?? '', figure });
      }
      if (!layout.has(node.name)) for (const label of labelValues(node)) addTarget(label, node.name, null, bounds);
      if (directiveBodies.get(node.name) !== 'myst') return;
      for (const child of node.children ?? []) if (child.type === 'mystDirectiveBody') child.children?.forEach(n => rawWalk(n, bounds, figure));
      return;
    }
    const children = node.children ?? [];
    let targets: Node[] = [];
    for (const child of children) {
      if (child.type === 'mystTarget') { targets.push(child); continue; }
      if (!(child.type === 'heading' && document.sections.some(s => s.startLine === (targets[0]?.position?.start.line ?? -1))) && !(child.type === 'mystDirective' && layout.has(child.name))) {
        for (const target of targets) addTarget(target.label, child.name ?? child.type, null, range(child), range(target).startLine);
      }
      targets = []; rawWalk(child, bounds, figure);
    }
  };
  rawWalk(raw);
  const addTable = (node: Node, table: Node | undefined, syntax: string, caption: string | null, referenceOnly: boolean) => {
    const rows = table?.children?.filter(n => n.type === 'tableRow');
    const headerRows = rows?.filter(row => row.children?.every(c => c.header));
    const item: Table = { ...common(node, `table-${document.tables.length + 1}`), syntax, caption,
      headers: headerRows?.flatMap(row => row.children?.map(text) ?? []) ?? [], rowCount: rows?.length ?? null,
      headerRowCount: headerRows?.length ?? null, columnCount: rows ? Math.max(0, ...rows.map(row => row.children?.length ?? 0)) : null,
      contentStatus: referenceOnly ? 'referenceOnly' : 'inline' };
    document.tables.push(item);
  };
  const semanticWalk = (node: Node, inherited?: ReturnType<typeof range>, containedTable = false) => {
    const bounds = range(node, inherited); node.position ??= { start: { line: bounds.startLine, column: 1 }, end: { line: bounds.endLine, column: 1 } };
    if (ignored.has(node.type)) return;
    if (node.type === 'mystDirective') {
      const isTable = ['table', 'list-table', 'csv-table'].includes(node.name) || (node.name === 'figure' && node.options?.kind === 'table');
      if (isTable) {
        const table = all(node, 'table')[0];
        const caption = node.name === 'figure' ? figureInfo(node).caption : text(all(node, 'caption')[0] ?? { type: 'text', value: node.args ?? '' }).trim() || null;
        addTable(node, table, `myst-${node.name}`, caption,
          !table || !!node.options?.file || !!all(node, 'embed').length);
        containedTable = true;
      }
    }
    if (node.type === 'table' && !containedTable) { addTable(node, node, 'markdown', null, false); containedTable = true; }
    node.children?.forEach(child => semanticWalk(child, bounds, containedTable));
  };
  semanticWalk(tree);
  // Some declared external tables are unsupported by this parser version. Keep their declaration and diagnostics.
  for (const node of tableDeclarations) {
    if (['table', 'list-table', 'csv-table'].includes(node.name) && !document.tables.some(item => item.startLine === range(node).startLine)) {
      addTable(node, undefined, `myst-${node.name}`, node.args || null, true);
    }
  }
  document.tables.sort((a, b) => a.startLine - b.startLine);
  document.tables.forEach((item, i) => { item.id = `table-${i + 1}`; });
  document.images.sort((a, b) => a.startLine - b.startLine);
  document.images.forEach((item, i) => { item.id = `image-${i + 1}`; });
  // Attach preceding MyST labels to content metadata and keep extraction ranges inclusive of labels.
  for (const items of [document.tables, document.images, document.glossaries]) for (const item of items) {
    const targets = document.targets.filter(t => t.nodeStartLine === item.startLine && t.kind !== 'section');
    const ownTargets = 'figure' in item && item.figure ? targets.filter(t => t.kind !== 'figure') : targets;
    item.labels = [...new Set([...item.labels, ...ownTargets.map(t => t.label)])];
    for (const target of ownTargets) target.id = item.id;
    item.startLine = Math.min(item.startLine, ...targets.map(t => t.startLine));
  }
  return document;
}

/** Slice using byte-preserving line boundaries, including CRLF and an unterminated final line. */
export function extract(source: string, startLine: number, endLine: number): string {
  const offsets = [0]; for (let i = 0; i < source.length; i++) if (source[i] === '\n') offsets.push(i + 1);
  return source.slice(offsets[startLine - 1] ?? source.length, offsets[endLine] ?? source.length);
}
