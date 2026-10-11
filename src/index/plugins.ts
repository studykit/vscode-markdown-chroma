import { parse } from 'acorn';

/** Names declared in a plugin, not the result of running its callbacks. */
export interface PluginNames {
  directives: string[]; roles: string[]; transforms: boolean; unavailable: boolean;
}
const unknown = Symbol('dynamic plugin metadata');
type Value = string | number | boolean | null | typeof unknown | Value[] | { [key: string]: Value };
const object = (value: Value): value is { [key: string]: Value } => !!value && typeof value === 'object' && !Array.isArray(value);
const empty = (): PluginNames => ({ directives: [], roles: [], transforms: false, unavailable: true });

function names(plugin: Value): PluginNames {
  if (!object(plugin)) return empty();
  const result: PluginNames = { directives: [], roles: [], transforms: false, unavailable: false };
  for (const kind of ['directives', 'roles'] as const) {
    const specs = plugin[kind];
    if (specs === undefined) continue;
    if (!Array.isArray(specs)) { result.unavailable = true; continue; }
    for (const spec of specs) {
      if (!object(spec) || typeof spec.name !== 'string' || !spec.name) { result.unavailable = true; continue; }
      result[kind].push(spec.name);
      if (spec.alias !== undefined) {
        if (!Array.isArray(spec.alias) || spec.alias.some(alias => typeof alias !== 'string' || !alias)) result.unavailable = true;
        else result[kind].push(...spec.alias as string[]);
      }
    }
    result[kind] = [...new Set(result[kind])];
  }
  result.transforms = plugin.transforms === unknown || (Array.isArray(plugin.transforms) ? !!plugin.transforms.length : !!plugin.transforms);
  return result;
}

/** Read literal objects/arrays and const references in an ESM default export. Never import or evaluate JS. */
function javascript(source: string): PluginNames {
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as any;
  const constants = new Map<string, any>(), variables = new Map<string, any>(), unsafe = new Set<string>();
  let exported: any;
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'VariableDeclaration') {
      const bind = (node: any, init: any) => {
        if (node?.type === 'Identifier') variables.set(node.name, init);
        else if (node?.type === 'ObjectPattern') node.properties.forEach((property: any) => bind(property.value ?? property.argument, init));
        else if (node?.type === 'ArrayPattern') node.elements.forEach((element: any) => bind(element, init));
        else if (node?.type === 'AssignmentPattern' || node?.type === 'RestElement') bind(node.left ?? node.argument, init);
      };
      for (const item of declaration.declarations) {
        bind(item.id, item.init);
        if (declaration.kind === 'const' && item.id.type === 'Identifier') constants.set(item.id.name, item.init);
      }
    }
    if (statement.type === 'ExportDefaultDeclaration') exported = statement.declaration;
    if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
      for (const spec of statement.specifiers) if (spec.exported.name === 'default') exported = spec.local;
    }
  }
  const root = (node: any): string | undefined => node?.type === 'Identifier' ? node.name
    : node?.type === 'MemberExpression' ? root(node.object) : undefined;
  const taint = (node: any) => { const name = root(node); if (name) unsafe.add(name); };
  const references = (node: any, found: Set<string>) => {
    if (!node || typeof node !== 'object' || /^(?:Function|ArrowFunction)/.test(node.type)) return;
    if (node.type === 'Identifier' && variables.has(node.name)) found.add(node.name);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => references(child, found));
      else if (value && typeof value === 'object') references(value, found);
    }
  };
  const inspect = (node: any) => {
    if (!node || typeof node !== 'object' || /^(?:Function|ArrowFunction)/.test(node.type)) return;
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') { taint(node.left ?? node.argument); references(node.right, unsafe); }
    if (node.type === 'UnaryExpression' && node.operator === 'delete') taint(node.argument);
    if (node.type === 'CallExpression') {
      if (node.callee.type === 'MemberExpression') taint(node.callee.object);
      for (const arg of node.arguments) references(arg, unsafe);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(inspect);
      else if (value && typeof value === 'object') inspect(value);
    }
  };
  inspect(program);
  // Mutating an alias or a containing array can also mutate referenced specifications.
  for (const name of unsafe) references(variables.get(name), unsafe);
  const evaluate = (node: any, stack: string[] = [], depth = 0): Value => {
    if (!node || depth > 64) return unknown;
    if (node.type === 'Literal' && (node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value))) return node.value;
    if (node.type === 'Identifier' && constants.has(node.name) && !unsafe.has(node.name) && !stack.includes(node.name))
      return evaluate(constants.get(node.name), [...stack, node.name], depth + 1);
    if (node.type === 'ArrayExpression') {
      const items: Value[] = [];
      for (const element of node.elements) {
        const value = evaluate(element?.type === 'SpreadElement' ? element.argument : element, stack, depth + 1);
        if (element?.type === 'SpreadElement') { if (!Array.isArray(value)) return unknown; items.push(...value); }
        else items.push(value);
      }
      return items;
    }
    if (node.type === 'ObjectExpression') {
      const value: { [key: string]: Value } = Object.create(null);
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          const spread = evaluate(property.argument, stack, depth + 1);
          if (!object(spread)) return unknown;
          Object.assign(value, spread); continue;
        }
        const key = property.computed ? evaluate(property.key, stack, depth + 1) : property.key.name ?? property.key.value;
        if (typeof key !== 'string') return unknown;
        value[key] = property.kind === 'init' && !property.method ? evaluate(property.value, stack, depth + 1) : unknown;
      }
      return value;
    }
    return unknown;
  };
  return names(evaluate(exported));
}

interface Token { value: string; string?: boolean; start: number; end: number }
/** A literal-only Python reader: the conventional top-level `plugin = {...}` specification. */
function python(source: string): PluginNames {
  const tokens: Token[] = [];
  for (let i = 0; i < source.length;) {
    const start = i, char = source[i];
    if (/\s/.test(char)) { i++; continue; }
    if (char === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (char === '"' || char === "'") {
      const quote = source.slice(i, i + 3) === char.repeat(3) ? char.repeat(3) : char;
      i += quote.length; let value = '', closed = false;
      while (i < source.length) {
        if (source.startsWith(quote, i)) { i += quote.length; closed = true; break; }
        if (source[i] !== '\\') { value += source[i++]; continue; }
        const escaped = source[++i]; i++;
        if (escaped === '\n') continue;
        const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07', '\\': '\\', '"': '"', "'": "'" };
        if (escaped in escapes) value += escapes[escaped];
        else if (['x', 'u', 'U'].includes(escaped)) {
          const length = escaped === 'x' ? 2 : escaped === 'u' ? 4 : 8;
          const digits = source.slice(i, i + length);
          if (!new RegExp(`^[a-f\\d]{${length}}$`, 'i').test(digits)) throw new Error('Invalid Python string escape.');
          value += String.fromCodePoint(parseInt(digits, 16)); i += length;
        } else if (/^[0-7]$/.test(escaped)) {
          const rest = /^[0-7]{0,2}/.exec(source.slice(i))![0];
          value += String.fromCodePoint(parseInt(escaped + rest, 8)); i += rest.length;
        } else if (escaped === 'N') throw new Error('Named Python Unicode escapes are not inspected.');
        else value += '\\' + escaped;
      }
      if (!closed) throw new Error('Unclosed Python string.');
      tokens.push({ value, string: true, start, end: i });
    } else {
      const word = /^[a-zA-Z_][\w]*|^\d+(?:\.\d+)?/.exec(source.slice(i));
      i += word?.[0].length ?? 1; tokens.push({ value: word?.[0] ?? char, start, end: i });
    }
    if (tokens.length > 100000) throw new Error('Python plugin specification is too complex.');
  }
  const assignments = tokens.flatMap((token, i) => token.value === 'plugin' && !token.string && tokens[i + 1]?.value === '='
    && token.start === source.lastIndexOf('\n', token.start - 1) + 1 ? [i] : []);
  if (assignments.length !== 1) return empty();
  let at = assignments[0] + 2;
  const is = (value: string) => tokens[at]?.value === value && !tokens[at].string;
  const literal = (depth = 0): Value => {
    if (depth > 64) throw new Error('Python plugin specification is too deeply nested.');
    const token = tokens[at++]; if (!token) throw new Error('Incomplete Python plugin specification.');
    if (token.string) return token.value;
    if (token.value === '{' || token.value === '[') {
      const close = token.value === '{' ? '}' : ']';
      const dict: { [key: string]: Value } = Object.create(null), list: Value[] = [];
      while (!is(close)) {
        const value = literal(depth + 1);
        if (close === '}') {
          if (typeof value !== 'string' || !is(':')) throw new Error('Expected a literal Python dictionary.');
          at++;
          dict[value] = literal(depth + 1);
        } else list.push(value);
        if (is(close)) break;
        if (!is(',')) throw new Error('Expected a literal Python list or dictionary.');
        at++;
      }
      at++; return close === '}' ? dict : list;
    }
    if (token.value === 'True' || token.value === 'False') return token.value === 'True';
    if (token.value === 'None') return null;
    if (/^\d+(?:\.\d+)?$/.test(token.value)) return Number(token.value);
    throw new Error('Dynamic Python plugin specification.');
  };
  const plugin = literal();
  // Reject expressions following the literal and later writes/method calls to the specification.
  if (tokens[at] && !source.slice(tokens[at - 1].end, tokens[at].start).includes('\n')) return empty();
  if (tokens.slice(at).some((token, i, rest) => !token.string && token.value === 'plugin'
    && (['.', '[', '='].includes(rest[i + 1]?.value) || rest[i - 1]?.value === '='))) return empty();
  return names(plugin);
}

export function inspectPlugin(source: string, kind: 'javascript' | 'python'): PluginNames {
  try { return kind === 'javascript' ? javascript(source) : python(source); }
  catch { return empty(); }
}
