import { normalizeLabel, toText } from 'myst-common';
import type { VFile } from 'vfile';

interface Node { type: string; children?: Node[]; position?: { start: { line: number; column: number }; end: { line: number; column: number } }; [key: string]: any }
const walk = (node: Node, visit: (node: Node) => void) => { visit(node); node.children?.forEach(child => walk(child, visit)); };
export const glossaryIdentifier = (name: string) => `term-${normalizeLabel(name)?.identifier ?? ''}`;

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

/** Alias references keep their authored display text and target the canonical definition. */
export function resolveGlossaryAliases(tree: Node): void {
  const targets = new Map<string, Node[]>(), aliases = new Set<string>();
  walk(tree, node => {
    if (node.type !== 'definitionTerm' || !node.identifier) return;
    for (const id of new Set<string>([node.identifier, ...(node.aliases ?? []).map(glossaryIdentifier)])) {
      const matches = targets.get(id) ?? []; matches.push(node); targets.set(id, matches);
      if (id !== node.identifier) aliases.add(id);
    }
  });
  walk(tree, node => {
    if (node.type !== 'crossReference' || !aliases.has(node.identifier)) return;
    const matches = targets.get(node.identifier)!;
    node.identifier = matches.length === 1 ? matches[0].identifier : `chroma-ambiguous-${node.identifier}`;
  });
}
