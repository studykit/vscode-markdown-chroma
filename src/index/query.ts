import * as z from 'zod/v4';
import { termIdentifier } from './parser';
import { MarkdownIndex, unresolved } from './project';
import { IndexError, SCHEMA_VERSION, normalizeTag, type Diagnostic, type Glossary, type Term } from './types';

const text = z.string().min(1);
const file = text.describe('Root-relative Markdown file path; use paths returned by list_notes.');
const ids = z.array(text).min(1).describe('Global IDs from list_terms or list_glossaries, in desired output order.');
const scope = { file: file.optional() };
const sectionScope = z.strictObject({ ...scope, section: text.optional() }).refine(value => !value.section || !!value.file, 'section requires file');
export const querySchemas = {
  index: z.strictObject({ rebuild: z.boolean().optional() }),
  notes: z.strictObject({ unresolved: z.boolean().optional() }),
  search: z.strictObject({ tags: z.array(text).min(1).optional(), exactTag: z.boolean().optional(),
    where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    hasProperty: z.array(text).min(1).optional(),
  }).refine(value => !!(value.tags?.length || value.hasProperty?.length || value.where !== undefined), 'At least one tag or property filter is required'),
  backlinks: z.strictObject({ file, term: text.optional() }),
  sections: z.strictObject({ file }),
  'read-section': z.strictObject({ file, id: text.optional(), label: text.optional(), includeChildren: z.boolean().optional(), sourceHash: text.optional() })
    .refine(value => !!value.id !== !!value.label, 'Specify exactly one id or label'),
  tables: sectionScope,
  images: sectionScope,
  glossaries: z.strictObject(scope),
  terms: z.strictObject({ ...scope, glossary: text.optional(), name: text.optional() }),
  'read-term': z.strictObject({ ids: ids.optional(), names: z.array(text).min(1).optional(), ...scope, sourceHash: text.optional() })
    .refine(value => !!value.ids !== !!value.names && !(value.ids && value.file), 'Specify names or ids; file only applies to names'),
  'read-glossary': z.strictObject({ ids }),
  read: z.strictObject({ ids }),
};
export type QueryCommand = keyof typeof querySchemas;
export type QueryArguments<C extends QueryCommand> = z.infer<(typeof querySchemas)[C]>;
export type IndexQuery = { [C in QueryCommand]: { command: C; arguments: QueryArguments<C> } }[QueryCommand];
export function errorRecord(error: unknown) {
  return error instanceof IndexError ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
    : { code: 'internalError', message: error instanceof Error ? error.message : String(error) };
}
export type ReadItem = ((Term | Glossary) & { kind: 'term' | 'glossary'; status: 'ok'; content: string })
  | { selector: string; status: 'error'; error: ReturnType<typeof errorRecord> };
export type QueryResult = Awaited<ReturnType<typeof executeQuery>>;

/** A root-bound service. Requests serialize so each reads one coherent, refreshed snapshot. */
export class IndexService {
  private readonly index: MarkdownIndex;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(root?: string, cacheDirectory?: string) { this.index = new MarkdownIndex(root, cacheDirectory); }
  get root() { return this.index.root; }
  execute(query: IndexQuery, options: { signal?: AbortSignal } = {}): Promise<QueryResult> {
    const schema = querySchemas[query.command];
    if (!schema) return Promise.reject(new IndexError('invalidArguments', 'Unknown query command.'));
    const parsed = schema.safeParse(query.arguments);
    if (!parsed.success) return Promise.reject(new IndexError('invalidArguments', parsed.error.message));
    const validated = { command: query.command, arguments: parsed.data } as IndexQuery;
    const operation = this.pending.then(async () => {
      options.signal?.throwIfAborted();
      await this.index.refresh(validated.command === 'index' && !!validated.arguments.rebuild, options.signal);
      options.signal?.throwIfAborted();
      return executeQuery(this.index, validated);
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}

function executeQuery(index: MarkdownIndex, query: IndexQuery) {
  const envelope = <T extends object>(result: T, complete = index.complete): T & { schemaVersion: number; complete: boolean; diagnostics?: Diagnostic[] } =>
    ({ schemaVersion: SCHEMA_VERSION, complete, ...result, ...(index.diagnostics.length ? { diagnostics: index.diagnostics } : {}) });
  const documents = index.data.documents;
  switch (query.command) {
    case 'index': return envelope({ root: index.root, cacheFile: index.cacheFile, generation: index.data.generation, documentCount: documents.length, ...index.stats });
    case 'notes':
    case 'search': {
      const args = query.command === 'search' ? query.arguments : {};
      const onlyUnresolved = query.command === 'notes' && query.arguments.unresolved;
      const tags = args.tags?.map(normalizeTag) ?? [];
      const notes = documents.filter(document => {
        if (onlyUnresolved && !document.outgoing.some(unresolved)) return false;
        if (!tags.every(tag => document.tags.some(t => t.normalized === tag || (!args.exactTag && t.normalized.startsWith(tag + '/'))))) return false;
        if (!(args.hasProperty ?? []).every(property => Object.hasOwn(document.properties, property))) return false;
        return Object.entries(args.where ?? {}).every(([property, wanted]) => Object.hasOwn(document.properties, property) && (Array.isArray(document.properties[property]) ? (document.properties[property] as unknown[]).some(v => v === wanted) : document.properties[property] === wanted));
      }).map(document => ({ file: document.file, sourceHash: document.sourceHash, properties: document.properties, tags: document.tags, aliases: document.aliases,
        sectionCount: document.sections.length, tableCount: document.tables.length, imageCount: document.images.length, glossaryCount: document.glossaries.length, termCount: document.terms.length,
        outgoing: document.outgoing, diagnostics: document.diagnostics }));
      return envelope({ root: index.root, notes });
    }
    case 'sections': {
      const document = index.document(query.arguments.file);
      return envelope({ file: document.file, sourceHash: document.sourceHash, sections: document.sections });
    }
    case 'read-section': {
      const args = query.arguments, document = index.document(args.file), section = index.section(document, args.id, args.label);
      const includeChildren = args.includeChildren !== false;
      const endLine = includeChildren ? section.endLine : section.ownEndLine;
      const content = index.read({ ...section, file: document.file, sourceHash: document.sourceHash }, args.sourceHash, endLine);
      return envelope({ file: document.file, section, sourceHash: document.sourceHash, startLine: section.startLine, endLine, includeChildren, content });
    }
    case 'backlinks': {
      const document = index.document(query.arguments.file);
      return envelope({ file: document.file, backlinks: index.backlinks(document, query.arguments.term) });
    }
    case 'tables':
    case 'images': {
      const { file, section: sectionId } = query.arguments;
      const scope = file ? [index.document(file)] : documents;
      const section = sectionId ? index.section(scope[0], sectionId) : undefined;
      const inSection = (item: { startLine: number }) => !section || (item.startLine >= section.startLine && item.startLine <= section.endLine);
      return query.command === 'tables' ? envelope({ tables: scope.flatMap(d => d.tables).filter(inSection) }) : envelope({ images: scope.flatMap(d => d.images).filter(inSection) });
    }
    case 'glossaries': return envelope({ glossaries: (query.arguments.file ? [index.document(query.arguments.file)] : documents).flatMap(d => d.glossaries) });
    case 'terms': {
      const args = query.arguments, scope = args.file ? [index.document(args.file)] : documents;
      let glossaryId = args.glossary;
      if (glossaryId) {
        const matches = scope.flatMap(d => d.glossaries).filter(g => g.id === glossaryId || (args.file && g.localId === glossaryId));
        if (matches.length !== 1) throw new IndexError('glossaryNotFound', 'Use a glossary ID from the glossaries list.');
        glossaryId = matches[0].id;
      }
      return envelope({ terms: scope.flatMap(d => d.terms).filter(term => (!glossaryId || term.glossaryId === glossaryId) && (!args.name || term.identifier === termIdentifier(args.name))) });
    }
    case 'read-term':
    case 'read-glossary':
    case 'read': {
      const args = query.arguments, termArgs = query.command === 'read-term' ? query.arguments : undefined;
      const terms = documents.flatMap(d => d.terms), glossaries = documents.flatMap(d => d.glossaries);
      const file = termArgs?.file ? index.document(termArgs.file).file : undefined;
      const selectors = args.ids ?? termArgs!.names!;
      const candidates = (selector: string) => terms.filter(t => t.identifier === termIdentifier(selector) && (!file || t.file === file));
      const pool = query.command === 'read-term' ? terms : query.command === 'read-glossary' ? glossaries : [...terms, ...glossaries];
      const selected = selectors.map(selector => {
        if (args.ids) return pool.find(item => item.id === selector);
        const matches = candidates(selector); return matches.length === 1 ? matches[0] : undefined;
      });
      if (termArgs?.sourceHash && new Set(selected.filter(Boolean).map(item => item!.file)).size > 1) throw new IndexError('invalidArguments', '--source-hash requires selections in one document.');
      const seen = new Set<string>(), items: ReadItem[] = [];
      for (let i = 0; i < selectors.length; i++) {
        const selector = selectors[i], item = selected[i], identity = item?.id ?? selector;
        if (seen.has(identity)) continue; seen.add(identity);
        try {
          if (!item) {
            const matches = args.ids ? [] : candidates(selector);
            throw new IndexError(matches.length ? 'ambiguousTerm' : query.command === 'read-glossary' ? 'glossaryNotFound' : query.command === 'read' ? 'itemNotFound' : 'termNotFound', matches.length ? `Multiple definitions match: ${selector}` : `Item was not found: ${selector}`, matches.length ? matches : undefined);
          }
          items.push({ kind: 'glossaryId' in item ? 'term' : 'glossary', ...item, status: 'ok', content: index.read(item, termArgs?.sourceHash) });
        } catch (error) { items.push({ selector, status: 'error', error: errorRecord(error) }); }
      }
      return envelope({ items }, index.complete && items.every(item => item.status === 'ok'));
    }
  }
}
