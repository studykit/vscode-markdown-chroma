import * as path from 'node:path';
import * as fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { defaultOptions } from 'myst-parser';
import { normalizeLabel } from 'myst-common';
import { VFile } from 'vfile';
import { parseFrontmatter } from '../frontmatter';
import { mergeSettings } from '../myst-config';
import { previewMystOptions } from '../myst-options';
import { parseExpansion } from '../preview-plugins/expansion-parser';
import { codeFence, markdownFromAst, occurrences, selectOccurrence, type ExpansionNode, type Occurrence } from './expansion-source';
import { extract, hash } from './parser';
import { MarkdownIndex } from './project';
import { IndexError, SCHEMA_VERSION, type Diagnostic, type Resolution } from './types';

export interface ExpansionOptions { allowProjectPlugins?: boolean; workerFile?: string; timeoutMs?: number }
export interface ExpansionArguments { file: string; line: number; maxChars?: number; maxDepth?: number; sourceHash?: string }
export interface ExpansionResult {
  schemaVersion: number; expansion: true; complete: boolean; file: string; line: number; directive: string;
  startLine: number; endLine: number; sourceHash: string; content: string; sources: { file: string; line: number }[];
  diagnostics: Diagnostic[]; logs: string;
}

const builtinNames = new Set([...defaultOptions.directives, ...previewMystOptions.directives].flatMap(spec => [spec.name, ...(typeof spec.alias === 'string' ? [spec.alias] : spec.alias ?? [])]));
const executableSource = (item: Occurrence) => {
  // A directive selected inside a list/quote must keep its authored body indent,
  // while removing the surrounding container prefix before standalone parsing.
  const lines = item.source.split('\n'), marker = lines[0].search(/(?:`{3,}|:{3,})\{/);
  const source = marker <= 0 ? item.source : lines.map(line => line.slice(Math.min(marker, /^[\s>]*(?:[-+*]\s+|\d+[.)]\s+)?/.exec(line)?.[0].length ?? 0))).join('\n');
  return '\n'.repeat(item.startLine - 1) + source;
};

/** Fresh workers deliberately avoid stale plugin graphs and untracked fs inputs. */
async function runPlugin(index: MarkdownIndex, source: string, file: string, settings: any, plugins: { file: string; label: string }[], maxDepth: number, options: ExpansionOptions, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let workerFile = options.workerFile ?? path.join(__dirname, 'preview-plugin-worker.cjs');
  if (!fs.existsSync(workerFile) && !options.workerFile) workerFile = path.join(__dirname, '..', 'preview-plugin-worker.cjs');
  const worker = new Worker(workerFile, { workerData: { root: index.root, plugins, expansion: true }, resourceLimits: { maxOldGenerationSizeMb: 128 }, stdout: true, stderr: true });
  let logs = '';
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', data => { logs = (logs + data.toString()).slice(-32768); });
  try {
    const result = await new Promise<any>((resolve, reject) => {
      const finish = (value: any, error?: unknown) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(undefined, new IndexError('expansionTimeout', 'Project plugin expansion exceeded its runtime limit.')), options.timeoutMs ?? 2000);
      const abort = () => finish(undefined, signal!.reason);
      signal?.addEventListener('abort', abort, { once: true });
      worker.on('error', error => finish(undefined, new IndexError('pluginExecutionFailed', error.message)));
      worker.on('exit', code => finish(undefined, new IndexError('pluginExecutionFailed', `Plugin worker stopped before returning a result (${code}).`)));
      worker.on('message', message => {
        if (message.ready) worker.postMessage({ id: 1, source, file: path.join(index.root, file), settings: settings.settings, maxDepth });
        else if (message.failed || message.error) finish(undefined, new IndexError('pluginExecutionFailed', message.failed ?? message.error));
        else if (message.result) finish(message.result);
      });
      if (signal?.aborted) abort();
    });
    return { ...result, logs };
  } finally { await worker.terminate(); }
}

/** No mutations of persisted records: this is an explicit source expansion, not indexing. */
export async function expandDirective(index: MarkdownIndex, args: ExpansionArguments, options: ExpansionOptions = {}, signal?: AbortSignal): Promise<ExpansionResult> {
  const source = index.readExpansionSource(args.file), file = path.posix.normalize(args.file);
  if (!/\.(md|markdown)$/i.test(file)) throw new IndexError('invalidFile', 'Select an occurrence in a Markdown file.');
  const sourceHash = hash(source);
  if (args.sourceHash && args.sourceHash !== sourceHash) throw new IndexError('documentChanged', 'Document changed; observe its source line again.');
  const selected = selectOccurrence(source, args.line);
  const diagnostics: Diagnostic[] = [], sources: { file: string; line: number }[] = [];
  let logs = '', count = 0;
  const maxDepth = args.maxDepth ?? 1, maxChars = args.maxChars ?? 12000;
  const issue = (message: string, origin = file, code = 'expansionPartial') => {
    if (!diagnostics.some(item => item.file === origin && item.code === code && item.message === message)) diagnostics.push({ code, message, file: origin, severity: 'warning' });
  };
  const origin = (file: string, line: number) => { if (!sources.some(item => item.file === file && item.line === line)) sources.push({ file, line }); };
  const resolve = (resolution: Resolution) => {
    if (resolution.status === 'ambiguous' || resolution.fragmentStatus === 'ambiguous') throw new IndexError('ambiguousTarget', `Multiple expansion targets match${resolution.candidates?.length ? ': ' + resolution.candidates.join(', ') : '; select a unique heading or label'}.`, resolution.candidates?.map(file => ({ file })));
    if (resolution.status !== 'found' || !resolution.file) throw new IndexError('expansionTargetUnavailable', `Expansion target is ${resolution.status}. Only local files inside the root are supported.`);
    if (resolution.fragmentStatus === 'notIndexed') throw new IndexError('unsupportedExpansion', 'Notebook output and Obsidian block-ID expansion are not supported.');
    if (resolution.fragmentStatus === 'missing') throw new IndexError('expansionTargetUnavailable', 'The target heading or label was not found.');
    return resolution.file;
  };
  const follow = (target: string, fragment: string | null, owner: string, wiki: boolean, label: boolean) => {
    // Existing recorded resolutions retain project label precedence and ambiguity.
    const reference = index.document(owner).outgoing.find(item => item.kind === 'embed' && item.target === target && item.fragment === fragment && (item.syntax === 'obsidian') === wiki);
    let resolution = reference?.resolution ?? index.resolveFile(target, owner, wiki);
    if (label && !reference && (!target || (!target.includes('.') && !target.includes('/')))) {
      const all = index.data.documents.flatMap(doc => doc.targets.filter(item => item.identifier === normalizeLabel(fragment ?? target)?.identifier).map(item => ({ doc, item })));
      const explicit = all.filter(match => !match.item.implicit), local = all.filter(match => match.doc.file === owner);
      const matches = explicit.length ? explicit : local.length ? local : all;
      if (matches.length === 1) resolution = { status: 'found', file: matches[0].doc.file, targetKind: matches[0].item.kind, targetId: matches[0].item.id ?? undefined, fragmentStatus: 'found' };
      else if (matches.length > 1) resolution = { status: 'ambiguous', candidates: matches.map(item => item.doc.file) };
    }
    if (resolution.status === 'found' && resolution.file && fragment && !resolution.targetKind) {
      const document = index.data.documents.find(item => item.file === resolution.file);
      if (fragment.startsWith('^') || !document) resolution.fragmentStatus = 'notIndexed';
      else {
        const identifier = normalizeLabel(fragment)?.identifier;
        const sections = document.sections.filter(item => item.id === fragment || item.headingPath.join('#').toLowerCase() === fragment.toLowerCase() || item.title.toLowerCase() === fragment.toLowerCase() || item.labels.some(label => normalizeLabel(label)?.identifier === identifier));
        const labels = document.targets.filter(item => item.kind !== 'section' && item.identifier === identifier);
        const matches = [...sections.map(item => ({ id: item.id, kind: 'section' })), ...labels];
        if (matches.length === 1) resolution = { ...resolution, targetId: matches[0].id ?? undefined, targetKind: matches[0].kind, fragmentStatus: 'found' };
        else resolution.fragmentStatus = matches.length ? 'ambiguous' : 'missing';
      }
    }
    const targetFile = resolve(resolution), text = index.readExpansionSource(targetFile);
    if (!/\.(md|markdown)$/i.test(targetFile)) throw new IndexError('unsupportedExpansion', 'Document embeds require a saved Markdown target.');
    if (fragment !== null || resolution.targetKind) {
      const document = index.document(targetFile);
      const item = resolution.targetKind === 'section' ? document.sections.find(item => item.id === resolution.targetId)
        : document.targets.find(item => item.id === resolution.targetId || item.label === fragment || item.label === target);
      if (!item) throw new IndexError('expansionTargetUnavailable', 'The target heading or content label is not available.');
      return { file: targetFile, text: extract(text, item.startLine, item.endLine), line: item.startLine };
    }
    return { file: targetFile, text, line: 1 };
  };
  const included = (node: ExpansionNode, owner: string, rawOptions: Record<string, any>) => {
    const target = resolve(index.resolveFile(node.file, owner));
    let content = index.readExpansionSource(target), line = 1;
    if (/\.ipynb$/i.test(target)) throw new IndexError('unsupportedExpansion', 'Notebook content expansion is not supported.');
    const lines = content.split('\n');
    const opts = rawOptions;
    const startMarker = opts['start-at'] ?? opts['start-after'], endMarker = opts['end-at'] ?? opts['end-before'];
    let start = opts['start-line'] !== undefined ? Number(opts['start-line']) : 0;
    if (start < 0) start += lines.length;
    if (startMarker !== undefined) { start = lines.findIndex(text => text.includes(startMarker)); if (start < 0) throw new IndexError('includeFilterNotFound', 'Include start marker was not found.'); if (opts['start-after'] !== undefined) start++; }
    let end = opts['end-line'] !== undefined ? Number(opts['end-line']) : lines.length;
    if (end < 0) end += lines.length;
    if (endMarker !== undefined) { const offset = lines.slice(start).findIndex(text => text.includes(endMarker)); if (offset < 0) throw new IndexError('includeFilterNotFound', 'Include end marker was not found.'); end = start + offset + Number(opts['end-at'] !== undefined); }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > lines.length) throw new IndexError('invalidIncludeFilter', 'Include line filters are outside the saved file.');
    content = lines.slice(start, end).join('\n'); line = start + 1;
    if (opts.lines !== undefined) {
      const indexes: number[] = [];
      for (const part of String(opts.lines).split(',')) {
        const match = /^\s*(\d+)(?:\s*-\s*(\d*)\s*)?$/.exec(part);
        if (!match) throw new IndexError('invalidIncludeFilter', 'Invalid include lines selection.');
        const first = Number(match[1]), last = match[2] === undefined ? first : match[2] ? Number(match[2]) : lines.length;
        if (first < 1 || last < first || last > lines.length) throw new IndexError('invalidIncludeFilter', 'Include lines are outside the saved file.');
        for (let i = first; i <= last; i++) indexes.push(i - 1);
      }
      content = indexes.map(i => lines[i]).join('\n'); line = indexes[0] + 1;
    }
    return { file: target, text: content, line, literal: node.literal, lang: node.lang };
  };
  const expandText = async (text: string, owner: string, line: number, depth: number, stack: string[]): Promise<string> => {
    origin(owner, line);
    const all = occurrences(text), items = all.filter(item => !all.some(parent => parent.startLine < item.startLine && parent.endLine >= item.endLine));
    if (!items.length) return text;
    let result = '', cursor = 0;
    for (const item of items) {
      result += text.slice(cursor, item.startOffset);
      if (depth >= maxDepth) { issue('Nested expansion depth limit reached; original syntax retained.', owner); result += item.source; }
      else try { result += await expand({ ...item, startLine: item.startLine + line - 1, endLine: item.endLine + line - 1 }, owner, depth + 1, stack); }
      catch (error) { if (signal?.aborted) throw error; issue(error instanceof Error ? error.message : String(error), owner); result += item.source; }
      cursor = item.endOffset;
    }
    return result + text.slice(cursor);
  };
  const expand = async (item: Occurrence, owner: string, depth: number, stack: string[]): Promise<string> => {
    signal?.throwIfAborted();
    if (++count > 32) throw new IndexError('expansionLimit', 'Expansion exceeds the 32-occurrence limit.');
    const identity = `${owner}:${item.startLine}:${item.source}`;
    if (stack.includes(identity)) throw new IndexError('expansionCycle', 'Cyclic include/embed expansion stopped.');
    const nextStack = [...stack, identity]; origin(owner, item.startLine);
    if (item.name === 'obsidian-embed') {
      const [target, ...fragment] = item.node.target.split('#');
      const content = follow(target.trim(), fragment.length ? fragment.join('#') : null, owner, true, false);
      return expandText(content.text, content.file, content.line, depth, nextStack);
    }
    const config = index.expansionConfiguration(owner);
    if (config.error) throw new IndexError('invalidConfig', config.error);
    const source = index.readExpansionSource(owner);
    const settings = mergeSettings(config.project, parseFrontmatter(source)?.values ?? {});
    // Only myst.yml declarations authorize executable code, never page overrides.
    settings.plugins = config.project.plugins;
    let tree: ExpansionNode;
    if (builtinNames.has(item.name) && (['include', 'literalinclude', 'embed'].includes(item.name) || !(options.allowProjectPlugins && Array.isArray(settings.plugins) && settings.plugins.length))) {
      const vfile = new VFile({ path: owner });
      tree = parseExpansion(executableSource(item), vfile, [], [], settings.settings, Math.max(1, maxDepth - depth + 1));
      for (const message of vfile.messages) issue(message.reason, owner, 'expansionSyntax');
    } else {
      if (!options.allowProjectPlugins) throw new IndexError('projectPluginsDisabled', 'Project plugin expansion is disabled. Enable --allow-project-plugins at the CLI or server launch.');
      if (!Array.isArray(settings.plugins)) throw new IndexError('pluginDefinitionsUnavailable', 'No project plugin list is registered in myst.yml.');
      const plugins = settings.plugins.map((entry: any) => {
        const target = typeof entry === 'string' ? entry : entry?.type === 'javascript' ? entry.path : undefined;
        if (typeof target !== 'string' || !/\.m?js$/i.test(target) || path.isAbsolute(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || /[\0\\]/.test(target)) throw new IndexError('unsupportedPlugin', 'Only registered relative local JavaScript ESM plugins are supported.');
        const pluginFile = path.posix.normalize(path.posix.join(path.posix.dirname(owner), target));
        index.readExpansionSource(pluginFile);
        return { file: path.join(index.root, pluginFile), label: pluginFile };
      });
      const result = await runPlugin(index, executableSource(item), owner, settings, plugins, Math.max(1, maxDepth - depth + 1), options, signal);
      tree = result.tree; logs += result.logs;
      for (const error of result.errors ?? []) issue(error, owner, 'pluginLoadingFailed');
      for (const message of result.messages ?? []) issue(message.reason, owner, 'expansionSyntax');
      for (const diagnostic of result.diagnostics ?? []) issue(diagnostic.reason, owner, 'pluginExecutionFailed');
    }
    const transform = async (node: ExpansionNode): Promise<ExpansionNode> => {
      if (node.type === 'include' || node.type === 'embed') {
        try {
          const referenceDepth = depth - 1 + (node._expansionDepth ?? 1);
          if (referenceDepth > maxDepth) {
            issue('Nested expansion depth limit reached; include/embed syntax retained.', owner);
            return { type: 'expansionSource', value: `:::{${node.type}} ${node.file ?? node.source?.label ?? ''}\n:::\n` };
          }
          if (node.type === 'include') {
            if (node.filter && !node._expansionOptions) throw new IndexError('unsupportedExpansion', 'Generated include filters without authored options are unsupported; include syntax retained.');
            const content = included(node, owner, node._expansionOptions ?? item.node.options ?? {}); origin(content.file, content.line);
            return { type: 'expansionSource', value: content.literal ? codeFence(content.text, content.lang) : await expandText(content.text, content.file, content.line, referenceDepth, nextStack) };
          }
          const value = node.source?.label ?? '';
          const original = item.node.args?.trim() ?? value;
          const raw = original.startsWith('#') ? original : value;
          const parts = raw.split('#');
          const content = follow(parts[0], parts.length > 1 ? parts.slice(1).join('#') : null, owner, false, true);
          return { type: 'expansionSource', value: await expandText(content.text, content.file, content.line, referenceDepth, nextStack) };
        } catch (error) { if (signal?.aborted) throw error; issue(error instanceof Error ? error.message : String(error), owner); return { type: 'expansionSource', value: item.source }; }
      }
      const children: ExpansionNode[] = [];
      for (const child of node.children ?? []) children.push(await transform(child));
      return { ...node, ...(node.children ? { children } : {}) };
    };
    return markdownFromAst(await transform(tree), message => issue(message, owner));
  };
  let content: string;
  try { content = await expand(selected, file, 1, []); }
  catch (error) {
    if (signal?.aborted || error instanceof IndexError && ['projectPluginsDisabled', 'invalidConfig', 'unsupportedPlugin', 'pluginDefinitionsUnavailable'].includes(error.code)) throw error;
    issue(error instanceof Error ? error.message : String(error), file, error instanceof IndexError ? error.code : 'expansionFailed'); content = selected.source;
  }
  const chars = Array.from(content);
  if (chars.length > maxChars) { content = chars.slice(0, maxChars).join(''); issue('Expanded content exceeded maxChars; returned content is truncated.', file, 'expansionBudget'); }
  return { schemaVersion: SCHEMA_VERSION, expansion: true, complete: !diagnostics.length, file, line: args.line, directive: selected.name,
    startLine: selected.startLine, endLine: selected.endLine, sourceHash, content, sources, diagnostics, logs: logs.slice(-32768) };
}
