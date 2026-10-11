import { posix } from 'node:path';
import type { IndexQuery, QueryResult, errorRecord } from './query';
import type { Section } from './types';
import type { ReadSelection, SelectionInfo } from './types';

type ErrorRecord = ReturnType<typeof errorRecord>;
export interface SectionOutline { title: string; id?: string; children?: SectionOutline[] }

/** Full Node/debug results retain snapshot diagnostics; retrieval status follows the requested scope. */
export function retrievalStatus(result: QueryResult, query?: IndexQuery) {
  const all = result.diagnostics ?? [];
  if ('expansion' in result) return { complete: result.complete, diagnostics: all, issues: all.map(issue => ({ file: issue.file, message: issue.message })) };
  const globalTermSelection = (query?.command === 'read-term' && !!query.arguments.names && !query.arguments.file)
    || (query?.command === 'read' && query.arguments.selections?.some(selection => selection.kind === 'term' && !selection.file));
  const sourceRead = !globalTermSelection && (query?.command === 'read' || query?.command.startsWith('read-'));
  const files = new Map<string, { startLine: number; endLine: number }[] | undefined>();
  const scopedBatch = query?.command === 'read' && query.arguments.selections?.every(s => !!s.file);
  if (scopedBatch && query?.command === 'read') for (const s of query.arguments.selections!) files.set(posix.normalize(s.file!), undefined);
  if ('sections' in result) files.set(result.file, undefined);
  else if ('content' in result) files.set(result.file, [{ startLine: result.startLine, endLine: result.endLine }]);
  else if (query && 'file' in query.arguments && query.arguments.file && query.command !== 'backlinks') {
    files.set(posix.normalize(query.arguments.file), undefined);
  }
  if ('items' in result && query && (('ids' in query.arguments && query.arguments.ids) || query.command === 'read-glossary'
    || scopedBatch || ('file' in query.arguments && query.arguments.file))) {
    for (const item of result.items) if (item.status === 'ok' || item.status === 'omitted') {
      const ranges = files.get(item.file) ?? [];
      ranges.push({ startLine: item.startLine, endLine: item.endLine }); files.set(item.file, ranges);
    }
  }
  const relevant = all.filter(issue => !sourceRead || issue.code !== 'pluginContentNotIndexed');
  const diagnostics = files.size ? relevant.filter(issue => {
    if (!issue.file) return true;
    // Scan failures in containing directories can affect any requested file below them.
    if (issue.code === 'directoryReadFailed') return [...files.keys()].some(file => !issue.file || file.startsWith(issue.file + '/'));
    if (!files.has(issue.file)) return false;
    const ranges = files.get(issue.file);
    return !ranges || issue.code !== 'mystSyntax' || !issue.line || ranges.some(range => issue.line! >= range.startLine && issue.line! <= range.endLine);
  }) : relevant;
  const itemError = 'items' in result && result.items.some(item => item.status !== 'ok');
  const complete = result.complete || (!!all.length && !diagnostics.length && !itemError);
  const affected = [...new Set(diagnostics.map(issue => issue.file).filter(Boolean))];
  const action = query?.command === 'read-lines' ? 'read' : 'indexed';
  const plugins = diagnostics.some(issue => issue.code === 'pluginContentNotIndexed' || issue.code === 'pluginDefinitionsUnavailable');
  const other = diagnostics.some(issue => issue.code !== 'pluginContentNotIndexed' && issue.code !== 'pluginDefinitionsUnavailable');
  const unavailable = diagnostics.some(issue => issue.code === 'pluginDefinitionsUnavailable');
  const message = [
    ...(other ? [`Some content could not be fully ${action}${affected.length > 1 ? ` in ${affected.length} files` : ''}. Results may be partial.`] : []),
    ...(unavailable ? ['Some project plugin definitions could not be inspected.'] : []),
    ...(plugins ? ['Project plugins are not executed; generated content is not included in the index.'] : []),
  ].join(' ');
  const issues: { file?: string; message: string }[] = !diagnostics.length ? [] : affected.length === 1
    ? [{ file: affected[0]!, message }]
    : [{ message }];
  return { complete, diagnostics, issues };
}

/** Retrieval responses expose choices and content, rather than index records. */
export function sectionOutline(sections: Section[]): SectionOutline[] {
  const roots: SectionOutline[] = [], ancestors: SectionOutline[] = [];
  for (const section of sections) {
    const item: SectionOutline = section.id === 'preamble' ? { title: '[preamble]', id: 'preamble' } : { title: section.title };
    const depth = Math.max(0, section.headingPath.length - 1);
    ancestors.length = depth;
    const parent = ancestors[depth - 1];
    if (parent) (parent.children ??= []).push(item); else roots.push(item);
    ancestors.push(item);
  }
  return roots;
}

export function presentError(error: ErrorRecord) {
  const internal = ['internalError', 'cacheWriteFailed', 'cacheLocked'].includes(error.code);
  let message = error.message;
  if (error.code === 'invalidArguments') {
    try {
      const issues = JSON.parse(message);
      if (Array.isArray(issues) && issues.length && issues.every(issue => typeof issue.message === 'string'))
        message = issues.map(issue => `${Array.isArray(issue.path) && issue.path.length ? issue.path.join('.') + ': ' : ''}${issue.message}`).join('; ');
    } catch { /* CLI argument errors are already plain text. */ }
  }
  const candidates = Array.isArray(error.details) ? error.details.map(candidate => {
    if (!candidate || typeof candidate !== 'object') return undefined;
    const fields = Object.hasOwn(candidate, 'name') && Object.hasOwn(candidate, 'file') ? ['id', 'name', 'file']
      : ['id', 'title', 'name', 'line', 'headingPath', 'file', 'kind', 'label'];
    return Object.fromEntries(fields
      .filter(key => Object.hasOwn(candidate, key)).map(key => [key, candidate[key]]));
  }).filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate && Object.keys(candidate).length > 0) : [];
  return { code: error.code, message: internal ? 'Unable to prepare the documents. Try again later.' : message,
    ...(candidates.length ? { candidates } : {}) };
}

const display = (value: string) => value.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ');
const cliLocation = (item: { file: string; headingPath: string[] }) =>
  `${display(item.file)} [${item.headingPath.length ? item.headingPath.map(display).join(' > ') : 'preamble'}]`;
const list = (rows: string[], empty: string) => rows.length ? rows.map(row => `- ${row}\n`).join('') : `${empty}\n`;

/** Text output for the CLI; MCP keeps its structured retrieval responses. */
export function formatCliResult(result: QueryResult): string {
  if ('documentCount' in result) return `Indexed ${result.documentCount} documents${result.complete ? '' : ' (partial)'}.\n`;
  if ('notes' in result) return list(result.notes.map(note => `${display(note.title)} (${display(note.file)})`), 'No notes found.');
  if ('sections' in result) return result.sections.map(section => `${'  '.repeat(Math.max(0, section.headingPath.length - 1))}${section.id === 'preamble' ? '[preamble]' : display(section.title)}\n`).join('');
  if ('content' in result) return result.content;
  if ('backlinks' in result) return list(result.backlinks.map(link => `${cliLocation(link)}: ${display(link.raw)} (${link.kind})`), 'No backlinks found.');
  if ('tables' in result) return list(result.tables.map(table => `${cliLocation(table)}: ${[
    ...(table.caption ? [display(table.caption)] : []), ...(table.headers.length ? [`headers: ${table.headers.map(display).join(' | ')}`] : []),
  ].join('; ') || 'table'}${table.contentStatus === 'referenceOnly' ? ' (external data)' : ''}`), 'No tables found.');
  if ('images' in result) return list(result.images.map(image => `${cliLocation(image)}: ${display(image.source)}${image.alt ? `; alt: ${display(image.alt)}` : ''}${image.figure?.caption ? `; caption: ${display(image.figure.caption)}` : ''}${image.resolution?.status === 'missing' ? ' (missing)' : ''}`), 'No images found.');
  if ('terms' in result) return list(result.terms.map(term => `${display(term.name)} (${display(term.file)})`), 'No terms found.');
  if ('glossaries' in result) {
    const counts = new Map<string, number>(), titles = new Map<string, number>();
    for (const glossary of result.glossaries) {
      const key = JSON.stringify([glossary.file, glossary.headingPath]); counts.set(key, (counts.get(key) ?? 0) + 1);
      const titleKey = JSON.stringify([glossary.file, glossary.headingPath.at(-1)]); titles.set(titleKey, (titles.get(titleKey) ?? 0) + 1);
    }
    return list(result.glossaries.map(glossary => {
      const title = glossary.headingPath.at(-1) ?? glossary.name ?? '[preamble]';
      const needsId = !glossary.headingPath.length || counts.get(JSON.stringify([glossary.file, glossary.headingPath]))! > 1;
      const titleKey = JSON.stringify([glossary.file, glossary.headingPath.at(-1)]);
      const choice = titles.get(titleKey)! > 1 && glossary.headingPath.length ? glossary.headingPath.map(display).join(' > ') : display(title);
      return `${choice} (${display(glossary.file)}; ${glossary.termCount} ${glossary.termCount === 1 ? 'term' : 'terms'}${needsId ? `; id: ${glossary.id}` : ''})`;
    }), 'No glossaries found.');
  }
  if ('budget' in result) return result.items.filter(item => item.status === 'ok').map(item => {
    if (item.status !== 'ok') return '';
    const name = item.kind === 'section' ? item.headingPath.join(' > ') || item.title : item.name;
    const covers = item.covers?.map(c => c.kind === 'section' ? c.headingPath.join(' > ') || c.title : c.name);
    return `\n<!-- ${item.kind}: ${display(name)} | ${display(item.file)}${covers?.length ? '; also covers: ' + covers.map(display).join(', ') : ''} -->\n${item.content}`;
  }).join('');
  return result.items.filter(item => item.status === 'ok').map(item => {
    if (item.status !== 'ok') return '';
    return `${result.items.length > 1 ? `\n<!-- ${item.kind}: ${display(item.name ?? '')} | ${display(item.file)} -->\n` : ''}${item.content}`;
  }).join('');
}

export function formatCliError(error: ErrorRecord): string {
  const record = presentError(error);
  const candidates = (record.candidates ?? []).map(candidate => {
    const title = candidate.title ?? candidate.name ?? candidate.label ?? candidate.kind ?? 'Selection';
    const context = [...(candidate.file ? [display(candidate.file)] : []),
      ...(candidate.headingPath?.length ? [candidate.headingPath.map(display).join(' > ')] : []),
      ...(candidate.id ? [`id: ${candidate.id}`] : []), ...(candidate.kind ? [`kind: ${candidate.kind}`] : [])];
    return `  - ${display(title)}${context.length ? ` (${context.join('; ')})` : ''}\n`;
  }).join('');
  return `${record.code}: ${record.message}\n${candidates}`;
}

const location = (item: { file: string; headingPath: string[] }) => ({ file: item.file,
  ...(item.headingPath.length ? { headingPath: item.headingPath } : { sectionId: 'preamble' }) });
const selectionInfo = (item: SelectionInfo) => item.kind === 'section'
  ? { kind: item.kind, file: item.file, title: item.title, headingPath: item.headingPath }
  : { kind: item.kind, file: item.file, name: item.name };
const presentSelection = (selection: ReadSelection) => {
  const { sourceHash: _hash, ...choice } = selection; return choice;
};

export function presentResult(result: QueryResult, query?: IndexQuery): Record<string, unknown> & { complete: boolean } {
  let data: Record<string, unknown>;
  if ('documentCount' in result) data = { documents: result.documentCount };
  else if ('notes' in result) data = { notes: result.notes.map(note => ({ file: note.file, title: note.title })) };
  else if ('sections' in result) data = { file: result.file, sections: sectionOutline(result.sections) };
  else if ('expansion' in result) data = { file: result.file, line: result.line, directive: result.directive, content: result.content, sources: result.sources };
  else if ('content' in result) data = { file: result.file, content: result.content };
  else if ('backlinks' in result) data = { file: result.file,
    backlinks: result.backlinks.map(link => ({ ...location(link), kind: link.kind, text: link.raw })) };
  else if ('tables' in result) data = { tables: result.tables.map(table => ({ ...location(table),
    ...(table.caption ? { caption: table.caption } : {}), ...(table.headers?.length ? { headers: table.headers } : {}),
    ...(table.contentStatus === 'referenceOnly' ? { externalData: true } : {}) })) };
  else if ('images' in result) data = { images: result.images.map(image => ({ ...location(image), source: image.source,
    ...(image.alt ? { alt: image.alt } : {}), ...(image.figure?.caption ? { caption: image.figure.caption } : {}),
    ...(image.resolution?.status === 'missing' ? { missing: true } : {}) })) };
  else if ('glossaries' in result) {
    const titles = new Map<string, number>();
    for (const glossary of result.glossaries) { const key = JSON.stringify([glossary.file, glossary.headingPath.at(-1)]); titles.set(key, (titles.get(key) ?? 0) + 1); }
    data = { glossaries: result.glossaries.map(glossary => ({ id: glossary.id, file: glossary.file,
      ...(glossary.headingPath.length ? { title: glossary.headingPath.at(-1), ...(titles.get(JSON.stringify([glossary.file, glossary.headingPath.at(-1)]))! > 1 ? { headingPath: glossary.headingPath } : {}) } : {}),
      ...(glossary.name ? { name: glossary.name } : {}), terms: glossary.termCount })) };
  }
  else if ('terms' in result) data = { terms: result.terms.map(term => ({ id: term.id, name: term.name, file: term.file })) };
  else if ('budget' in result) data = { items: result.items.map(item => item.status === 'error'
    ? { selector: presentSelection(item.selector), error: presentError(item.error) }
    : { ...selectionInfo(item), ...(item.covers?.length ? { covers: item.covers.map(selectionInfo) } : {}),
      ...(item.status === 'ok' ? { content: item.content } : { omitted: true, reason: 'budget', requiredChars: item.requiredChars }) }),
    ...(result.items.some(item => item.status === 'omitted') ? { budget: result.budget } : {}) };
  else data = { items: result.items.map(item => item.status === 'error' ? { selector: item.selector, error: presentError(item.error) }
    : { kind: item.kind, file: item.file, ...(item.name ? { name: item.name } : {}), content: item.content }) };
  const status = retrievalStatus(result, query);
  return { complete: status.complete, ...data, ...(status.issues.length ? { issues: status.issues } : {}) };
}
