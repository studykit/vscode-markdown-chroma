import { matchesTermName } from './terms';
import type { MarkdownIndex } from './project';
import { IndexError, errorRecord, type ReadSelection, type SelectionInfo, type BatchReadItem } from './types';

export const DEFAULT_READ_CHARS = 12000;
interface Selected { info: SelectionInfo; startLine: number; endLine: number; sourceHash: string; order: number }
interface Group { file: string; startLine: number; endLine: number; members: Selected[] }

/** Merge selected source intervals before reading; bodies remain transient and never enter the cache. */
export function readBatch(index: MarkdownIndex, selections: ReadSelection[], maxChars = DEFAULT_READ_CHARS) {
  const selected: Selected[] = [], failures: { order: number; item: BatchReadItem }[] = [];
  const seen = new Set<string>();
  selections.forEach((selector, order) => {
    const key = JSON.stringify(Object.fromEntries(Object.entries(selector).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
    if (seen.has(key)) return; seen.add(key);
    try {
      let item: Selected;
      if (selector.kind === 'section') {
        const document = index.document(selector.file);
        const section = selector.line === undefined
          ? index.section(document, selector.id, selector.label, selector.title, selector.headingPath)
          : index.sectionAtLine(document, selector.line);
        item = { info: { kind: 'section', file: document.file, title: section.title, headingPath: section.headingPath },
          startLine: section.startLine, endLine: selector.includeChildren ? section.endLine : section.ownEndLine,
          sourceHash: document.sourceHash, order };
      } else {
        const file = selector.file ? index.document(selector.file).file : undefined;
        const matches = index.data.documents.flatMap(d => d.terms)
          .filter(t => matchesTermName(t, selector.name) && (!file || file === t.file));
        if (matches.length !== 1) throw new IndexError(matches.length ? 'ambiguousTerm' : 'termNotFound',
          matches.length ? `Multiple definitions match: ${selector.name}` : `Term was not found: ${selector.name}`, matches.length ? matches : undefined);
        const term = matches[0];
        item = { info: { kind: 'term', file: term.file, name: term.name }, startLine: term.startLine, endLine: term.endLine,
          sourceHash: term.sourceHash, order };
      }
      if (selector.sourceHash && selector.sourceHash !== item.sourceHash)
        throw new IndexError('documentChanged', `Document changed; list its items again: ${item.info.file}`);
      selected.push(item);
    } catch (error) { failures.push({ order, item: { status: 'error', selector, error: errorRecord(error) } }); }
  });

  const groups: Group[] = [];
  for (const item of selected.sort((a, b) => (a.info.file < b.info.file ? -1 : a.info.file > b.info.file ? 1 : 0) || a.startLine - b.startLine || a.order - b.order)) {
    const last = groups.at(-1);
    if (last?.file === item.info.file && item.startLine <= last.endLine) {
      last.endLine = Math.max(last.endLine, item.endLine); last.members.push(item);
    } else groups.push({ file: item.info.file, startLine: item.startLine, endLine: item.endLine, members: [item] });
  }
  const entries = [...failures, ...groups.map(group => ({ order: Math.min(...group.members.map(m => m.order)), group }))]
    .sort((a, b) => a.order - b.order);
  const items: BatchReadItem[] = []; let usedChars = 0;
  for (const entry of entries) {
    if ('item' in entry) { items.push(entry.item); continue; }
    const group = entry.group;
    const members = group.members.sort((a, b) => a.order - b.order);
    const representative = [...members].sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine) || a.order - b.order)[0];
    const infoKey = (info: SelectionInfo) => JSON.stringify(info);
    const infos = new Map(members.map(m => [infoKey(m.info), m.info])); infos.delete(infoKey(representative.info));
    const base = { ...representative.info, startLine: group.startLine, endLine: group.endLine, sourceHash: representative.sourceHash,
      ...(infos.size ? { covers: [...infos.values()] } : {}) };
    try {
      const content = index.read(base);
      let requiredChars = 0; for (const _character of content) requiredChars++;
      if (usedChars + requiredChars > maxChars) items.push({ ...base, status: 'omitted', reason: 'budget', requiredChars });
      else { usedChars += requiredChars; items.push({ ...base, status: 'ok', content }); }
    } catch (error) {
      // Keep every affected selection actionable when a merged saved-source read fails.
      for (const member of members) items.push({ status: 'error', selector: selections[member.order], error: errorRecord(error) });
    }
  }
  return { items, budget: { maxChars, usedChars } };
}
