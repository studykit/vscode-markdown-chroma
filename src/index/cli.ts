import { IndexService, errorRecord, type IndexQuery, type QueryCommand } from './query';
import { IndexError, SCHEMA_VERSION } from './types';

const help = `Markdown Chroma — saved Markdown/MyST structure and reference index

Usage: markdown-chroma <command> [file or term names] [options]

  mcp                       Serve MCP over stdio or HTTP (mcp --help for options)
  index                     Create/update the disk index (--rebuild to reparse all)
  watch                     Index saved files on changes (watch --help for options)
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
    const queryArguments: Record<string, unknown> = {};
    const mapping: Record<string, string> = { tag: 'tags', 'has-property': 'hasProperty', 'exact-tag': 'exactTag', 'source-hash': 'sourceHash' };
    for (const [name, list] of values) {
      if (['root', 'cache-dir', 'json', 'where', 'no-children'].includes(name)) continue;
      const key = name === 'id' ? (command === 'read-section' ? 'id' : 'ids') : mapping[name] ?? name;
      queryArguments[key] = repeated.has(name) && key !== 'id' ? list : flags.has(name) ? true : list[0];
    }
    if (has('where')) queryArguments.where = where;
    if (has('no-children')) queryArguments.includeChildren = false;
    if (positional.length) queryArguments[command === 'read-term' ? 'names' : 'file'] = command === 'read-term' ? positional : positional[0];
    const service = new IndexService(get('root'), get('cache-dir'));
    const result = await service.execute({ command: command as QueryCommand, arguments: queryArguments } as IndexQuery);
    for (const diagnostic of result.diagnostics ?? []) io.stderr(`${diagnostic.file ?? '.'}${diagnostic.line ? ':' + diagnostic.line : ''}: ${diagnostic.code}: ${diagnostic.message}\n`);
    if (!has('json') && 'content' in result) io.stdout(result.content);
    else if (!has('json') && 'items' in result) {
      for (const item of result.items) {
        if (item.status === 'error') { io.stderr(`${item.error.code}: ${item.error.message}\n${item.error.details ? JSON.stringify(item.error.details) + '\n' : ''}`); continue; }
        if (result.items.length > 1) io.stdout(`\n<!-- ${item.kind}: ${JSON.stringify(item.name)} | ${JSON.stringify(item.file)} | ${JSON.stringify(item.id)} -->\n`);
        io.stdout(item.content);
      }
    } else io.stdout(JSON.stringify(result, null, 2) + '\n');
    return result.complete ? 0 : 1;
  } catch (error) {
    const record = errorRecord(error);
    const jsonOutput = argv.includes('--json') || argv.includes('--json=true') || (parsed && !['help', 'read', 'read-term', 'read-glossary', 'read-section'].includes(parsed.command)) || (!parsed && !argv[0]?.startsWith('read'));
    if (jsonOutput) io.stdout(JSON.stringify({ schemaVersion: SCHEMA_VERSION, complete: false, error: record }, null, 2) + '\n');
    io.stderr(`${record.code}: ${record.message}\n`);
    return record.code === 'invalidArguments' ? 2 : 1;
  }
}
