import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as parser from 'myst-parser';
import * as directives from 'myst-directives';
import * as roles from 'myst-roles';
import * as common from 'myst-common';
import * as transforms from 'myst-transforms';
import * as frontmatter from 'myst-frontmatter';
import * as grid from 'myst-ext-grid';
import * as card from 'myst-ext-card';
import * as tabs from 'myst-ext-tabs';
import * as proof from 'myst-ext-proof';
import * as exercise from 'myst-ext-exercise';
import * as button from 'myst-ext-button';
import * as builder from 'unist-builder';
import * as vfiles from 'vfile';
import { previewMystOptions } from '../myst-options';
import type { PluginDiagnostic } from './events';
import { parseExpansion } from './expansion-parser';

const modules: Record<string, any> = {
  'myst-parser': parser, 'myst-directives': directives, 'myst-roles': roles,
  'myst-common': common, 'myst-transforms': transforms, 'myst-frontmatter': frontmatter,
  'myst-ext-grid': grid, 'myst-ext-card': card, 'myst-ext-tabs': tabs,
  'myst-ext-proof': proof, 'myst-ext-exercise': exercise, 'myst-ext-button': button,
  'unist-builder': builder, vfile: vfiles
};
(globalThis as any).__markdownChromaPluginModules = modules;
const bridges = Object.fromEntries(Object.entries(modules).map(([name, module]) => {
  const source = `const module = globalThis.__markdownChromaPluginModules[${JSON.stringify(name)}];\n` +
    Object.keys(module).filter(key => /^[a-zA-Z_$][\w$]*$/.test(key) && key !== 'default').map(key => `export const ${key} = module[${JSON.stringify(key)}];`).join('\n') +
    (Object.hasOwn(module, 'default') ? '\nexport default module.default;' : '');
  return [name, `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`];
}));
if (typeof register !== 'function') throw new Error('MyST project plugins require Node.js 20.6 or later.');
register(pathToFileURL(path.join(__dirname, 'preview-plugin-loader.cjs')), { data: { root: workerData.root, bridges } });

const errors: string[] = [];
const loadingDiagnostics: PluginDiagnostic[] = [];
let diagnostics: PluginDiagnostic[] = [];
let requestId = 0;
const pluginDirectives: any[] = [], pluginRoles: any[] = [];
const names = { directive: new Set<string>(), role: new Set<string>() };
const errorNode = (value: string) => [{ type: 'previewError', value }];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const detail = (error: unknown) => error instanceof Error ? error.stack : String(error);
const loadingError = (plugin: string, error: unknown) => {
  const reason = `MyST plugin ${plugin}: ${message(error)}`;
  errors.push(reason); loadingDiagnostics.push({ phase: 'loading', plugin, reason, detail: detail(error) });
};
const asyncValue = (value: any) => value && typeof value.then === 'function';
const normalizeType = (definition: any) => definition && ({ ...definition, type: definition.type === String ? 'string' : definition.type === Number ? 'number' : definition.type === Boolean ? 'boolean' : definition.type });

function validateOutput(nodes: any, depth = 0, count = { value: 0 }): void {
  if (!Array.isArray(nodes)) throw new Error('run() must return an array of MyST nodes.');
  if (depth > 64) throw new Error('Plugin output is too deeply nested.');
  for (const node of nodes) {
    if (++count.value > 20000) throw new Error('Plugin output exceeds the node limit.');
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') throw new Error('Plugin returned an invalid MyST node.');
    for (const key of ['value', 'url', 'src', 'identifier', 'html_id', 'class', 'label', 'title', 'alt', 'lang']) {
      if (node[key] !== undefined && typeof node[key] !== 'string') throw new Error(`Plugin node ${node.type}.${key} must be a string.`);
    }
    if (node.type === 'image' && typeof node.url !== 'string') throw new Error('Plugin image.url must be a string.');
    if (node.type === 'include' && typeof node.file !== 'string') throw new Error('Plugin include.file must be a string.');
    if (node.position !== undefined && ['start', 'end'].some(key => !Number.isInteger(node.position?.[key]?.line) || !Number.isInteger(node.position?.[key]?.column))) throw new Error('Plugin node position must contain valid source points.');
    if (node.type === 'heading' && (!Number.isInteger(node.depth) || node.depth < 1 || node.depth > 6)) throw new Error('Plugin heading depth must be 1–6.');
    if (node.children !== undefined) validateOutput(node.children, depth + 1, count);
  }
}
function wrap(spec: any, kind: 'directive' | 'role', label: string): any {
  if (!spec || typeof spec.name !== 'string' || !/^[\w:-]+$/.test(spec.name) || typeof spec.run !== 'function') throw new Error(`Invalid ${kind} definition.`);
  const aliases = typeof spec.alias === 'string' ? [spec.alias] : spec.alias ?? [];
  if (!Array.isArray(aliases) || aliases.some((name: any) => typeof name !== 'string' || !/^[\w:-]+$/.test(name))) throw new Error(`Invalid aliases for ${spec.name}.`);
  const declared = [spec.name, ...aliases];
  if (declared.some(name => names[kind].has(name))) throw new Error(`Duplicate project ${kind} name or alias: ${spec.name}.`);
  declared.forEach(name => names[kind].add(name));
  const run = (data: any, file: any, context: any) => {
    const location = data.node?.position?.start;
    const diagnosticContext = { plugin: `${label} (${kind} ${spec.name})`, file: file.path, line: location?.line, column: location?.column };
    parentPort!.postMessage({ id: requestId, executing: diagnosticContext });
    try {
      const firstMessage = file.messages.length;
      if (spec.validate) {
        data = spec.validate(data, file);
        if (asyncValue(data)) { void Promise.resolve(data).catch(() => {}); throw new Error('Asynchronous validate() is not supported.'); }
      }
      const output = spec.run(data, file, context);
      if (asyncValue(output)) { void Promise.resolve(output).catch(() => {}); throw new Error('Asynchronous run() is not supported.'); }
      validateOutput(output);
      const mark = (nodes: any[]) => { for (const node of nodes) { node._projectPlugin = `${label} (${kind} ${spec.name})`; if (node.children) mark(node.children); } };
      mark(output);
      const reported = file.messages.slice(firstMessage).filter((item: any) => item.fatal === true).at(-1);
      if (reported) return [...output, ...errorNode(`MyST plugin ${label} (${kind} ${spec.name}): ${reported.reason}`)];
      return output;
    } catch (error) {
      const reason = `MyST plugin ${label} (${kind} ${spec.name}): ${message(error)}`;
      diagnostics.push({ ...diagnosticContext, phase: 'execution', reason, detail: detail(error) });
      return errorNode(reason);
    }
  };
  return { ...spec, alias: aliases, validate: undefined, run, arg: normalizeType(spec.arg), body: normalizeType(spec.body),
    options: spec.options && Object.fromEntries(Object.entries(spec.options).map(([name, value]) => [name, normalizeType(value)])) };
}

async function start() {
  for (const plugin of workerData.plugins) {
    try {
      const imported = await import(pathToFileURL(plugin.file).href);
      const definition = imported.default;
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('Expected a default-exported MyST plugin object.');
      if (definition.transforms?.length) loadingError(plugin.label, new Error('transforms are not supported in Preview.'));
      for (const [key, kind, output] of [['directives', 'directive', pluginDirectives], ['roles', 'role', pluginRoles]] as const) {
        if (definition[key] !== undefined && !Array.isArray(definition[key])) throw new Error(`${key} must be an array.`);
        for (const spec of definition[key] ?? []) {
          try { output.push(wrap(spec, kind, plugin.label)); }
          catch (error) { loadingError(plugin.label, error); }
        }
      }
    } catch (error) { loadingError(plugin.label, error); }
  }
  parentPort!.postMessage({ ready: true, errors, diagnostics: loadingDiagnostics });
  parentPort!.on('message', ({ id, source, file, settings, maxDepth }) => {
    requestId = id; diagnostics = [];
    try {
      const vfile = new vfiles.VFile({ path: file });
      const tree = workerData.expansion ? parseExpansion(source, vfile, pluginDirectives, pluginRoles, settings, maxDepth) : parser.mystParse(source, { ...previewMystOptions,
        directives: [...previewMystOptions.directives, ...pluginDirectives], roles: [...previewMystOptions.roles, ...pluginRoles],
        extensions: { ...previewMystOptions.extensions, math: settings?.parser?.dollarmath === false ? { dollarmath: false, amsmath: true } : true }, vfile });
      const messages = vfile.messages.map(item => ({ reason: item.reason, line: item.line, column: item.column, fatal: item.fatal }));
      diagnostics.push(...messages.map(item => ({ phase: 'parsing' as const, file, reason: item.reason, line: item.line ?? undefined, column: item.column ?? undefined, severity: item.fatal ? 'error' as const : 'warning' as const })));
      const response = JSON.stringify({ tree, messages, errors, diagnostics });
      if (Buffer.byteLength(response) > 4 * 1024 * 1024) throw new Error('Plugin result exceeds the 4 MiB limit.');
      parentPort!.postMessage({ id, result: JSON.parse(response) });
    } catch (error) { parentPort!.postMessage({ id, error: message(error), detail: detail(error) }); }
  });
}
void start().catch(error => { parentPort!.postMessage({ failed: message(error), detail: detail(error) }); });
