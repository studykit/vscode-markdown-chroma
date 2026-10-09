import { termIdentifier } from './parser';
import { MarkdownIndex, unresolved } from './project';
import { IndexError, SCHEMA_VERSION, normalizeTag, type ContentItem, type Glossary, type Term } from './types';

const help = `Markdown Chroma — saved Markdown/MyST structure and reference index

Usage: markdown-chroma <command> [file or term names] [options]

  index                     Create/update the disk index (--rebuild to reparse all)
  notes                     List documents (--unresolved for unresolved references)
  search                    AND filters: --tag, --where JSON, --has-property
  backlinks <file>           Incoming references (--term local-or-global-id)
  sections <file>            List document-level headings, labels and source hash
  read-section <file>        --id section-id OR --label MyST-label [--no-children]
  tables [file]              List tables [--section section-id with file]
  images [file]              List image occurrences [--section section-id with file]
  glossaries [file]          List glossary directives across the root or one file
  terms [file]              List definitions [--glossary id] [--name exact-name]
  read-term <name...>        Read definitions, optionally limited by --file
  read-term --id <id>...     Read selected definitions by global IDs
  read-glossary --id <id>... Read selected whole glossaries by global IDs
  read --id <id>...          Read mixed term/glossary selections in input order

Global: --root <directory> (default: cwd), --cache-dir <directory>, --help
Reads:  --json for metadata/content; --source-hash <hash> for read-section/read-term
Search: repeated --tag/--has-property; --exact-tag excludes subtags
Lists/index/search return JSON (schemaVersion: 1). Reads default to raw Markdown.
Diagnostics go to stderr; partial results exit 1. Invalid arguments exit 2.
Requires Node >=20. Source/config/bibliography limit: 2 MiB per file.
Hidden paths, node_modules, _build and symlinks are excluded; .obsidian is unused.

Examples:
  markdown-chroma index --root ./notes
  markdown-chroma sections guide.md --root ./notes
  markdown-chroma read-section guide.md --id setup --no-children --root ./notes
  markdown-chroma search --tag project --where '{"status":"draft"}' --root ./notes
  markdown-chroma terms --root ./notes
  markdown-chroma read-term 'AST' 'MyST Markdown' --root ./notes --json
  markdown-chroma read --id 'a.md#term-ast' --id 'b.md#glossary-1' --json
`;
const commands: Record<string, string[]> = {
  index: ['rebuild'], notes: ['unresolved'], search: ['tag', 'where', 'has-property', 'exact-tag'],
  backlinks: ['term'], sections: [], 'read-section': ['id', 'label', 'no-children', 'source-hash'],
  tables: ['section'], images: ['section'], glossaries: [], terms: ['glossary', 'name'],
  'read-term': ['id', 'file', 'source-hash'], 'read-glossary': ['id'], read: ['id'],
};
const flags = new Set(['help', 'json', 'rebuild', 'unresolved', 'exact-tag', 'no-children']);
const repeated = new Set(['id', 'tag', 'has-property']);
interface Arguments { command: string; positional: string[]; values: Map<string, string[]> }
function parseArguments(argv: string[]): Arguments {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) return { command: 'help', positional: [], values: new Map() };
  const command = argv[0]; if (!commands[command]) throw new IndexError('invalidArguments', `Unknown command: ${command}. Use --help.`);
  const allowed = new Set(['root', 'cache-dir', 'json', ...commands[command]]);
  const values = new Map<string, string[]>(); const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!argument.startsWith('-')) { positional.push(argument); continue; }
    const option = /^--([\w-]+)(?:=(.*))?$/.exec(argument);
    if (!option || !allowed.has(option[1])) throw new IndexError('invalidArguments', `Unknown option for ${command}: ${argument}`);
    const name = option[1];
    if (values.has(name) && !repeated.has(name)) throw new IndexError('invalidArguments', `Option may only be supplied once: --${name}`);
    let value = option[2];
    if (flags.has(name)) { if (value !== undefined) throw new IndexError('invalidArguments', `--${name} does not take a value.`); value = 'true'; }
    else {
      if (value === undefined) { value = argv[++i]; if (!value || value.startsWith('--')) throw new IndexError('invalidArguments', `Missing value for --${name}.`); }
      if (!value) throw new IndexError('invalidArguments', `Empty value for --${name}.`);
    }
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  const has = (name: string) => values.has(name);
  const oneFile = ['backlinks', 'sections', 'read-section'].includes(command);
  const optionalFile = ['tables', 'images', 'glossaries', 'terms'].includes(command);
  if ((oneFile && positional.length !== 1) || (optionalFile && positional.length > 1) || (!oneFile && !optionalFile && command !== 'read-term' && positional.length)) throw new IndexError('invalidArguments', `Invalid positional arguments for ${command}. Use --help.`);
  if (command === 'read-section' && (has('id') === has('label') || (values.get('id')?.length ?? 0) > 1)) throw new IndexError('invalidArguments', 'read-section requires exactly one --id or --label.');
  if (['tables', 'images'].includes(command) && has('section') && !positional.length) throw new IndexError('invalidArguments', '--section requires a file.');
  if (command === 'read-term' && (has('id') === (positional.length > 0) || (has('id') && has('file')))) throw new IndexError('invalidArguments', 'read-term requires names OR global --id values; --file only applies to names.');
  if (['read', 'read-glossary'].includes(command) && !has('id')) throw new IndexError('invalidArguments', `${command} requires at least one --id.`);
  if (command === 'search' && !['tag', 'where', 'has-property'].some(has)) throw new IndexError('invalidArguments', 'search requires a tag or property filter.');
  return { command, positional, values };
}
export interface CliIO { stdout(value: string): void; stderr(value: string): void }
const defaultIO: CliIO = { stdout: value => process.stdout.write(value), stderr: value => process.stderr.write(value) };
function errorRecord(error: unknown) {
  return error instanceof IndexError ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
    : { code: 'internalError', message: error instanceof Error ? error.message : String(error) };
}

export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  let parsed: Arguments | undefined;
  try {
    parsed = parseArguments(argv);
    if (parsed.command === 'help') { io.stdout(help); return 0; }
    const { command, positional, values } = parsed;
    const get = (name: string) => values.get(name)?.[0]; const has = (name: string) => values.has(name);
    let where: Record<string, string | number | boolean | null> = {};
    if (has('where')) {
      try { where = JSON.parse(get('where')!); }
      catch { throw new IndexError('invalidArguments', '--where must be a JSON object.'); }
      if (!where || Array.isArray(where) || typeof where !== 'object' || Object.values(where).some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v))) throw new IndexError('invalidArguments', '--where values must be strings, numbers, booleans or null.');
    }
    const index = new MarkdownIndex(get('root'), get('cache-dir')); await index.refresh(has('rebuild'));
    const envelope = (result: Record<string, unknown>, complete = index.complete) => ({ schemaVersion: SCHEMA_VERSION, complete, ...result, ...(index.diagnostics.length ? { diagnostics: index.diagnostics } : {}) });
    const json = (value: unknown) => io.stdout(JSON.stringify(value, null, 2) + '\n');
    for (const diagnostic of index.diagnostics) io.stderr(`${diagnostic.file ?? '.'}${diagnostic.line ? ':' + diagnostic.line : ''}: ${diagnostic.code}: ${diagnostic.message}\n`);
    const documents = positional.length && ['tables', 'images', 'terms', 'glossaries'].includes(command) ? [index.document(positional[0])] : index.data.documents;
    if (command === 'index') json(envelope({ root: index.root, cacheFile: index.cacheFile, generation: index.data.generation, documentCount: documents.length, ...index.stats }));
    else if (command === 'notes' || command === 'search') {
      const tags = values.get('tag')?.map(normalizeTag) ?? [];
      const notes = documents.filter(document => {
        if (has('unresolved') && !document.outgoing.some(unresolved)) return false;
        if (!tags.every(tag => document.tags.some(t => t.normalized === tag || (!has('exact-tag') && t.normalized.startsWith(tag + '/'))))) return false;
        if (!(values.get('has-property') ?? []).every(property => Object.hasOwn(document.properties, property))) return false;
        return Object.entries(where).every(([property, wanted]) => Object.hasOwn(document.properties, property) && (Array.isArray(document.properties[property]) ? (document.properties[property] as unknown[]).some(v => v === wanted) : document.properties[property] === wanted));
      }).map(document => ({ file: document.file, sourceHash: document.sourceHash, properties: document.properties, tags: document.tags, aliases: document.aliases,
        sectionCount: document.sections.length, tableCount: document.tables.length, imageCount: document.images.length, glossaryCount: document.glossaries.length, termCount: document.terms.length,
        outgoing: document.outgoing, diagnostics: document.diagnostics }));
      json(envelope({ root: index.root, notes }));
    } else if (command === 'sections') {
      const document = index.document(positional[0]); json(envelope({ file: document.file, sourceHash: document.sourceHash, sections: document.sections }));
    } else if (command === 'read-section') {
      const document = index.document(positional[0]); const section = index.section(document, get('id'), get('label'));
      const endLine = has('no-children') ? section.ownEndLine : section.endLine;
      const content = index.read({ ...section, file: document.file, sourceHash: document.sourceHash }, get('source-hash'), endLine);
      if (has('json')) json(envelope({ file: document.file, section, sourceHash: document.sourceHash, startLine: section.startLine, endLine, includeChildren: !has('no-children'), content }));
      else io.stdout(content);
    } else if (command === 'backlinks') json(envelope({ file: index.document(positional[0]).file, backlinks: index.backlinks(index.document(positional[0]), get('term')) }));
    else if (command === 'tables' || command === 'images' || command === 'glossaries') {
      const section = get('section') ? index.section(documents[0], get('section')) : undefined;
      const items = documents.flatMap(document => document[command] as ContentItem[]).filter(item => !section || (item.startLine >= section.startLine && item.startLine <= section.endLine));
      json(envelope({ [command]: items }));
    } else if (command === 'terms') {
      let glossaryId = get('glossary');
      if (glossaryId) {
        const matches = documents.flatMap(d => d.glossaries).filter(g => g.id === glossaryId || (positional.length && g.localId === glossaryId));
        if (matches.length !== 1) throw new IndexError('glossaryNotFound', 'Use a glossary ID from the glossaries list.');
        glossaryId = matches[0].id;
      }
      const terms = documents.flatMap(d => d.terms).filter(term => (!glossaryId || term.glossaryId === glossaryId) && (!get('name') || term.identifier === termIdentifier(get('name')!)));
      json(envelope({ terms }));
    } else {
      const termDefinitions = index.data.documents.flatMap(d => d.terms);
      const glossaries = index.data.documents.flatMap(d => d.glossaries);
      if (get('file')) index.document(get('file')!);
      const selectors = values.get('id') ?? positional;
      const seen = new Set<string>();
      const items: Record<string, any>[] = [];
      const selected: (Term | Glossary | undefined)[] = selectors.map(selector => {
        if (has('id')) return command === 'read-term' ? termDefinitions.find(t => t.id === selector) : command === 'read-glossary' ? glossaries.find(g => g.id === selector) : [...termDefinitions, ...glossaries].find(item => item.id === selector);
        const candidates = termDefinitions.filter(t => t.identifier === termIdentifier(selector) && (!get('file') || t.file === index.document(get('file')!).file));
        return candidates.length === 1 ? candidates[0] : undefined;
      });
      if (has('source-hash') && new Set(selected.filter(Boolean).map(item => item!.file)).size > 1) throw new IndexError('invalidArguments', '--source-hash requires selections in one document.');
      for (let i = 0; i < selectors.length; i++) {
        const selector = selectors[i], item = selected[i];
        const identity = item?.id ?? selector;
        if (seen.has(identity)) continue; seen.add(identity);
        try {
          if (!item) {
            const candidates = has('id') ? [] : termDefinitions.filter(t => t.identifier === termIdentifier(selector) && (!get('file') || t.file === index.document(get('file')!).file));
            throw new IndexError(candidates.length ? 'ambiguousTerm' : command === 'read-glossary' ? 'glossaryNotFound' : command === 'read' ? 'itemNotFound' : 'termNotFound', candidates.length ? `Multiple definitions match: ${selector}` : `Item was not found: ${selector}`, candidates.length ? candidates : undefined);
          }
          const kind = 'glossaryId' in item ? 'term' : 'glossary';
          items.push({ kind, ...item, status: 'ok', content: index.read(item, get('source-hash')) });
        } catch (error) { items.push({ selector, status: 'error', error: errorRecord(error) }); }
      }
      const complete = index.complete && items.every(item => item.status === 'ok');
      if (has('json')) json(envelope({ items }, complete));
      else {
        for (const item of items) {
          if (item.status === 'error') { io.stderr(`${item.error.code}: ${item.error.message}\n${item.error.details ? JSON.stringify(item.error.details) + '\n' : ''}`); continue; }
          if (items.length > 1) io.stdout(`\n<!-- ${item.kind}: ${JSON.stringify(item.name)} | ${JSON.stringify(item.file)} | ${JSON.stringify(item.id)} -->\n`);
          io.stdout(item.content);
        }
      }
      return complete ? 0 : 1;
    }
    return index.complete ? 0 : 1;
  } catch (error) {
    const record = errorRecord(error);
    const jsonOutput = argv.includes('--json') || argv.includes('--json=true') || (parsed && !['help', 'read', 'read-term', 'read-glossary', 'read-section'].includes(parsed.command)) || (!parsed && !argv[0]?.startsWith('read'));
    if (jsonOutput) io.stdout(JSON.stringify({ schemaVersion: SCHEMA_VERSION, complete: false, error: record }, null, 2) + '\n');
    io.stderr(`${record.code}: ${record.message}\n`);
    return record.code === 'invalidArguments' ? 2 : 1;
  }
}
