import { fileError, normalizeLabel, toText, type DirectiveSpec, type GenericNode } from 'myst-common';
import type { VFile } from 'vfile';

interface TermNames { ko?: string; aliases?: string[]; formerly?: string[] }
interface Node extends TermNames { type: string; children?: Node[]; position?: { start: { line: number; column: number }; end: { line: number; column: number } }; [key: string]: any }
const walk = (node: Node, visit: (node: Node) => void) => { visit(node); node.children?.forEach(child => walk(child, visit)); };
export const glossaryIdentifier = (name: string) => `term-${normalizeLabel(name)?.identifier ?? ''}`;

export function termAlternateNames(term: TermNames): string[] {
  return [...(term.ko ? [term.ko] : []), ...(term.aliases ?? []), ...(term.formerly ?? [])];
}

const termLabels = {
  info: ['Term information', '용어 정보'],
  aliases: ['Aliases', '별칭'],
  formerly: ['Former names', '이전 이름'],
  related: ['Distinguish from', '구분할 용어'],
} as const;

export function termDetailLabel(key: unknown, language?: string): string | undefined {
  if (typeof key !== 'string' || !Object.hasOwn(termLabels, key)) return;
  return termLabels[key as keyof typeof termLabels][/^ko(?:-|$)/i.test(language ?? '') ? 1 : 0];
}

const text = (value: string): GenericNode => ({ type: 'text', value });
const detailLabel = (key: keyof typeof termLabels): GenericNode =>
  ({ type: 'text', value: termLabels[key][0], _termDetailLabel: key });
const names = (value: unknown): string[] =>
  typeof value === 'string' ? value.split(',').map(name => name.trim()).filter(Boolean) : [];

export const termOptionNames = { ko: 'ko', aliases: 'aliases', formerly: 'formerly', 'distinct-from': 'distinct-from' };

/** Built-in and declarative syntax extensions emit the same definition nodes. */
export function termDirective(name: string, keys = termOptionNames): DirectiveSpec {
  return {
    name,
    arg: { type: String, required: true },
    body: { type: 'myst', required: true },
    options: Object.fromEntries(Object.values(keys).map(key => [key, { type: String }])),
    run: (data, file) => renderTerm(data, file, keys),
  };
}

function renderTerm({ arg, body, options = {}, node }: Parameters<DirectiveSpec['run']>[0], file: VFile, keys: typeof termOptionNames): GenericNode[] {
  const name = typeof arg === 'string' ? arg.trim() : '';
  const normalized = normalizeLabel(name);
  if (!normalized?.identifier) {
    const message = 'A term definition needs a name.';
    fileError(file, message, { node });
    return [{ type: 'previewError', value: message }, ...(body as GenericNode[])];
  }
  const identifier = glossaryIdentifier(name);
  const korean = options[keys.ko];
  const ko = typeof korean === 'string' ? korean.trim() : '';
  const seen = new Set([identifier, ...(ko ? [glossaryIdentifier(ko)] : [])]);
  const alternates = (option: unknown) => names(option).filter(value => {
    const id = glossaryIdentifier(value);
    if (id === 'term-' || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const aliases = alternates(options[keys.aliases]), formerly = alternates(options[keys.formerly]);
  const related = names(options[keys['distinct-from']]);
  const fields: GenericNode[] = [];
  const field = (key: keyof typeof termLabels, values: GenericNode[]) => {
    if (values.length) fields.push({ type: 'definitionTerm', children: [detailLabel(key)] },
      { type: 'definitionDescription', children: values });
  };
  field('aliases', aliases.length ? [text(aliases.join(', '))] : []);
  field('formerly', formerly.length ? [text(formerly.join(', '))] : []);
  field('related', related.flatMap((value, index) => [
    ...(index ? [text(', ')] : []),
    { type: 'crossReference', identifier: glossaryIdentifier(value), label: value, children: [text(value)] },
  ]));
  const description = [...body as GenericNode[]];
  if (fields.length) description.push({ type: 'details', class: 'myst-term-details', children: [
    { type: 'summary', children: [detailLabel('info')] },
    { type: 'definitionList', class: 'myst-term-fields', children: fields },
  ] });
  return [{ type: 'definitionList', class: 'myst-term-definition', children: [
    { type: 'definitionTerm', standaloneTerm: true, identifier, label: name, html_id: `term-${normalized.html_id || normalized.identifier.replace(/ /g, '-')}`,
      position: node.position, ...(ko && ko !== name ? { ko } : {}), aliases, formerly, children: [text(name)] },
    { type: 'definitionDescription', children: description },
  ] }];
}

/** Adapt indented definitions through public parser APIs, retaining original line ranges. */
export function normalizeGlossaries(tree: Node, source: string, parse: (source: string) => Node, file?: VFile): void {
  const lines = source.split(/\r?\n/);
  const indent = (line: string) => /^\s*/.exec(line)![0].length;
  const parseAt = (source: string, startLine: number) => {
    const firstMessage = file?.messages.length ?? 0;
    const parsed = parse(source);
    for (const message of file?.messages.slice(firstMessage) ?? []) {
      if (message.line) message.line += startLine - 1;
      if (message.position) message.position = {
        start: { ...message.position.start, line: message.position.start.line + startLine - 1 },
        end: { ...message.position.end, line: message.position.end.line + startLine - 1 },
      };
    }
    walk(parsed, node => {
      if (node.position) node.position = {
        start: { ...node.position.start, line: node.position.start.line + startLine - 1 },
        end: { ...node.position.end, line: node.position.end.line + startLine - 1 },
      };
    });
    return parsed;
  };
  walk(tree, directive => {
    if (directive.type !== 'mystDirective' || directive.name !== 'glossary' || !directive.position) return;
    const body = directive.children?.find(child => child.type === 'glossary' || child.type === 'mystDirectiveBody');
    if (!body?.children) return;
    const base = indent(lines[directive.position.start.line - 1] ?? '');
    const limit = Math.min(lines.length, directive.position.end.line - 1);
    const result: Node[] = [];
    for (let i = 0; i < body.children.length; i++) {
      const node = body.children[i], start = (node.position?.start.line ?? 0) - 1;
      if (node.type !== 'paragraph' || start < 0 || start >= limit || indent(lines[start]) !== base) { result.push(node); continue; }
      let endNames = start;
      while (endNames < limit && lines[endNames].trim() && indent(lines[endNames]) === base) endNames++;
      let first = endNames;
      while (first < limit && !lines[first].trim()) first++;
      if (first >= limit || indent(lines[first]) <= base) { result.push(node); continue; }
      let end = first;
      while (end < limit && (!lines[end].trim() || indent(lines[end]) > base)) end++;
      while (end > first && !lines[end - 1].trim()) end--;
      const names = lines.slice(start, endNames).map((line, offset) => {
        const parsed = parseAt(line.slice(base), start + offset + 1).children ?? [];
        return { type: 'paragraph', children: parsed[0]?.children ?? [], position: { start: { line: start + offset + 1, column: base + 1 }, end: { line: start + offset + 1, column: line.length + 1 } } };
      });
      if (!names.length || names.some(name => !toText(name as any).trim())) { result.push(node); continue; }
      const primary = toText(names[0] as any).trim(), seen = new Set([glossaryIdentifier(primary)]);
      const aliases = names.slice(1).filter(name => {
        const id = glossaryIdentifier(toText(name as any).trim());
        if (seen.has(id)) return false;
        seen.add(id); return true;
      });
      const padding = lines.slice(first, end).filter(line => line.trim()).reduce((minimum, line) => Math.min(minimum, indent(line)), Infinity);
      const description = parseAt(lines.slice(first, end).map(line => line.slice(padding)).join('\n'), first + 1);
      const position = { start: names[0].position.start, end: { line: end, column: 1 } };
      result.push({ type: 'definitionList', position, children: [
        { type: 'definitionTerm', position: names[0].position, children: names[0].children,
          aliases: aliases.map(name => toText(name as any).trim()), aliasNodes: aliases },
        { type: 'definitionDescription', position: { start: { line: first + 1, column: padding + 1 }, end: position.end }, children: description.children ?? [] },
      ] });
      while (i + 1 < body.children.length && (body.children[i + 1].position?.start.line ?? Infinity) <= end) i++;
    }
    body.children = result;
  });
}

/** Alternate identifiers map to the canonical term. Any collision maps to null. */
export function glossaryAliasTargets(tree: Node): Map<string, string | null> {
  const targets = new Map<string, Node[]>();
  walk(tree, node => {
    if (!node.identifier || node.shadowedFolderTerm || (node.type !== 'definitionTerm' && !node.folderTerm)) return;
    const names = node.folderTerm ?? node;
    for (const id of new Set<string>([names.identifier, ...termAlternateNames(names).map(glossaryIdentifier)])) {
      const matches = targets.get(id) ?? []; matches.push(node); targets.set(id, matches);
    }
  });
  const aliases = new Map<string, string | null>();
  for (const [id, matches] of targets) {
    if (matches.length > 1) aliases.set(id, null);
    else if (id !== matches[0].identifier) aliases.set(id, matches[0].identifier);
  }
  return aliases;
}

/** Alias references keep their authored display text and target the canonical definition. */
export function resolveGlossaryAliases(tree: Node): void {
  const aliases = glossaryAliasTargets(tree);
  walk(tree, node => {
    if (node.type !== 'crossReference' || !aliases.has(node.identifier)) return;
    node.identifier = aliases.get(node.identifier) ?? `chroma-ambiguous-${node.identifier}`;
  });
}

/** A project renderer can supply its own presentation for a statically indexed term. */
export function applyDeclaredTermTargets(source: Node, rendered: Node, directiveNames: ReadonlySet<string>): void {
  const key = (node: Node) => `${node.name}:${node.position?.start.line}`;
  const terms = new Map<string, Node>();
  walk(source, node => {
    if (node.type !== 'mystDirective' || !directiveNames.has(node.name)) return;
    const term = node.children?.[0]?.children?.[0];
    if (term?.standaloneTerm) terms.set(key(node), term);
  });
  walk(rendered, directive => {
    if (directive.type !== 'mystDirective') return;
    const term = terms.get(key(directive));
    if (!term) return;
    walk(directive, node => {
      if (node.type !== 'definitionTerm' || node.standaloneTerm) return;
      if ((node.identifier ?? glossaryIdentifier(toText(node))) !== term.identifier) return;
      const { identifier, label, html_id, ko, aliases, formerly } = term;
      Object.assign(node, { identifier, label, html_id, ko, aliases, formerly });
      node.position ??= term.position;
    });
  });
}
