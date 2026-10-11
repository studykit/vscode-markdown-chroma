import { IndexService, errorRecord, type IndexQuery, type QueryCommand } from './query';
import { IndexError, SCHEMA_VERSION } from './types';
import { formatCliResult, formatCliError, presentResult, presentError, retrievalStatus } from './presentation';

const help = `Markdown Chroma — saved Markdown/MyST structure and reference index

Usage: markdown-chroma <command> [file or term names] [options]

  mcp                       Serve MCP over stdio or HTTP (mcp --help for options)
  index                     Create/update the disk index (--rebuild to reparse all)
  watch                     Index saved files on changes (watch --help for options)
  notes                     List files and titles (--unresolved for unresolved references)
  search                    AND filters: --tag, --where JSON, --has-property
  backlinks <file>           Incoming references (--term local-or-global-id)
  sections <file>            List titles as an outline; --json returns a title tree
  read-section <file>        --title OR --heading-path OR --id OR --label OR --line
  read-lines <file>          Read source --start line [--end line]; default 20 lines
  expand-directive <file>    Expand one observed opening --line; --max-depth/--max-chars
  read-frontmatter <file>    Read original YAML frontmatter, including delimiters
  tables [file]              List tables [--section section-id with file]
  images [file]              List image occurrences [--section section-id with file]
  glossaries [file]          List glossary directives across the root or one file
  terms [file]              List definitions [--glossary id] [--name exact-name]
  read-term <name...>        Read definitions, optionally limited by --file
  read-term --id <id>...     Read selected definitions by global IDs
  read-glossary <file>       Read a glossary by its owning --title or --heading-path
  read-glossary --id <id>... Read selected whole glossaries by global IDs
  read --id <id>...          Read mixed term/glossary selections in input order
  read --select <JSON>       Read sections/terms by titles/names; --max-chars budget

Global: --root <directory> (default: cwd), --cache-dir <directory>, --help
Expansion: --allow-project-plugins explicitly enables registered JavaScript code
Output: text by default; --json for concise retrieval JSON; --debug for full records
Reads:  --no-children for read-section's own body
        --source-hash <hash> to verify a saved read (hash from sections --debug)
Batch:  --select accepts 1–100 section/term choices; sections default to own body
        --max-chars defaults to 12000 Unicode characters; oversized groups are omitted
Search: repeated --tag/--has-property; --exact-tag excludes subtags
Line reads do not require or refresh the structural index. Use grep/rg for text search.
Sections default to a title outline. Other lists/index/search return readable text.
Reads default to raw Markdown. Titles match exactly; duplicate titles require a heading path.
Diagnostics go to stderr; partial results exit 1. Invalid arguments exit 2.
Requires Node >=20. Source/config/bibliography limit: 2 MiB per file.
Hidden paths, node_modules, _build and symlinks are excluded; .obsidian is unused.

Examples:
  markdown-chroma index --root ./notes
  markdown-chroma sections guide.md --root ./notes
  markdown-chroma read-section guide.md --title 'Setup' --no-children --root ./notes
  markdown-chroma read-section guide.md --heading-path '["Setup","macOS"]' --root ./notes
  markdown-chroma search --tag project --where '{"status":"draft"}' --root ./notes
  markdown-chroma read-section guide.md --line 42 --root ./notes
  markdown-chroma terms --root ./notes
  markdown-chroma read-term 'AST' 'MyST Markdown' --root ./notes
  markdown-chroma read-glossary terms.md --title 'Authoring terms' --root ./notes
  markdown-chroma read --id 'a.md#term-ast' --id 'b.md#glossary-1'
  markdown-chroma read --select '[{"kind":"section","file":"guide.md","title":"Setup"},{"kind":"term","name":"AST"}]'
`;
const commands: Record<string, string[]> = {
  'expand-directive': ['line', 'max-depth', 'max-chars', 'source-hash', 'allow-project-plugins'],
  index: ['rebuild'], notes: ['unresolved'], search: ['tag', 'where', 'has-property', 'exact-tag'],
  'read-frontmatter': ['source-hash'],
  'read-lines': ['start', 'end', 'source-hash'],
  backlinks: ['term'], sections: [], 'read-section': ['id', 'label', 'title', 'heading-path', 'line', 'no-children', 'source-hash'],
  tables: ['section'], images: ['section'], glossaries: [], terms: ['glossary', 'name'],
  'read-term': ['id', 'file', 'source-hash'], 'read-glossary': ['id', 'title', 'heading-path'], read: ['id', 'select', 'max-chars'],
};
const flags = new Set(['help', 'json', 'debug', 'rebuild', 'unresolved', 'exact-tag', 'no-children', 'allow-project-plugins']);
const repeated = new Set(['id', 'tag', 'has-property']);
interface Arguments { command: string; positional: string[]; values: Map<string, string[]> }
function parseArguments(argv: string[]): Arguments {
  const end = argv.indexOf('--'), options = end < 0 ? argv : argv.slice(0, end);
  if (!argv.length || options.includes('--help') || options.includes('-h')) return { command: 'help', positional: [], values: new Map() };
  const command = argv[0]; if (!commands[command]) throw new IndexError('invalidArguments', `Unknown command: ${command}. Use --help.`);
  const allowed = new Set(['root', 'cache-dir', 'json', 'debug', ...commands[command]]);
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
  const oneFile = ['backlinks', 'sections', 'read-section', 'read-frontmatter', 'read-lines', 'expand-directive'].includes(command);
  const optionalFile = ['tables', 'images', 'glossaries', 'terms', 'read-glossary'].includes(command);
  if ((oneFile && positional.length !== 1) || (optionalFile && positional.length > 1) || (!oneFile && !optionalFile && command !== 'read-term' && positional.length)) throw new IndexError('invalidArguments', `Invalid positional arguments for ${command}. Use --help.`);
  if (command === 'read-section' && (['id', 'label', 'title', 'heading-path', 'line'].filter(has).length !== 1 || (values.get('id')?.length ?? 0) > 1)) throw new IndexError('invalidArguments', 'read-section requires exactly one --title, --heading-path, --id, --label or --line.');
  if (['tables', 'images'].includes(command) && has('section') && !positional.length) throw new IndexError('invalidArguments', '--section requires a file.');
  if (command === 'read-term' && (has('id') === (positional.length > 0) || (has('id') && has('file')))) throw new IndexError('invalidArguments', 'read-term requires names OR global --id values; --file only applies to names.');
  if (command === 'read-glossary' && (has('id')
    ? positional.length > 0 || has('title') || has('heading-path')
    : positional.length !== 1 || ['title', 'heading-path'].filter(has).length !== 1))
    throw new IndexError('invalidArguments', 'read-glossary requires a file with --title or --heading-path, OR global --id values.');
  if (command === 'read' && (has('id') === has('select') || (has('max-chars') && !has('select'))))
    throw new IndexError('invalidArguments', 'read requires --select JSON OR --id values; --max-chars applies to --select.');
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
    const mapping: Record<string, string> = { tag: 'tags', 'has-property': 'hasProperty', 'exact-tag': 'exactTag', 'source-hash': 'sourceHash', 'heading-path': 'headingPath', start: 'startLine', end: 'endLine', select: 'selections', 'max-chars': 'maxChars', 'max-depth': 'maxDepth' };
    for (const [name, list] of values) {
      if (['root', 'cache-dir', 'json', 'debug', 'where', 'no-children', 'allow-project-plugins'].includes(name)) continue;
      const key = name === 'id' ? (command === 'read-section' ? 'id' : 'ids') : mapping[name] ?? name;
      if (name === 'heading-path' || name === 'select') {
        try { queryArguments[key] = JSON.parse(list[0]); }
        catch { throw new IndexError('invalidArguments', `--${name} must be a JSON array.`); }
      } else if (['line', 'start', 'end', 'max-chars', 'max-depth'].includes(name)) {
        if (!/^\d+$/.test(list[0])) throw new IndexError('invalidArguments', `--${name} requires an integer.`);
        queryArguments[key] = Number(list[0]);
      } else queryArguments[key] = repeated.has(name) && key !== 'id' ? list : flags.has(name) ? true : list[0];
    }
    if (has('where')) queryArguments.where = where;
    if (has('no-children')) queryArguments.includeChildren = false;
    if (positional.length) queryArguments[command === 'read-term' ? 'names' : 'file'] = command === 'read-term' ? positional : positional[0];
    const service = new IndexService(get('root'), get('cache-dir'), { allowProjectPlugins: has('allow-project-plugins') });
    const query = { command: command as QueryCommand, arguments: queryArguments } as IndexQuery;
    const result = await service.execute(query), status = retrievalStatus(result, query);
    if (has('debug')) for (const diagnostic of result.diagnostics ?? []) io.stderr(`${diagnostic.file ?? '.'}${diagnostic.line ? ':' + diagnostic.line : ''}: ${diagnostic.code}: ${diagnostic.message}\n`);
    else for (const issue of status.issues) io.stderr(`${issue.file ? issue.file + ': ' : ''}${issue.message}\n`);
    if (has('debug')) io.stdout(JSON.stringify(result, null, 2) + '\n');
    else if (has('json')) io.stdout(JSON.stringify(presentResult(result, query)) + '\n');
    else {
      if ('items' in result) for (const item of result.items) if (item.status === 'error') io.stderr(formatCliError(item.error));
      if ('budget' in result) for (const item of result.items) if (item.status === 'omitted')
        io.stderr(`${item.file}: ${'title' in item ? item.title : item.name}: Omitted within the read budget; needs ${item.requiredChars} characters. Request it separately or increase --max-chars.\n`);
      io.stdout(formatCliResult(result));
    }
    return (has('debug') ? result.complete : status.complete) ? 0 : 1;
  } catch (error) {
    const detailed = errorRecord(error);
    const debug = argv.includes('--debug') || argv.includes('--debug=true');
    const json = debug || argv.includes('--json') || argv.includes('--json=true');
    if (json) io.stdout(JSON.stringify({ ...(debug ? { schemaVersion: SCHEMA_VERSION } : {}), complete: false, error: debug ? detailed : presentError(detailed) }) + '\n');
    io.stderr(debug ? `${detailed.code}: ${detailed.message}\n` : formatCliError(detailed));
    return detailed.code === 'invalidArguments' ? 2 : 1;
  }
}
