import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { PluginDiagnostic, PluginEvent } from './events';

export interface PluginParseResult {
  tree?: any;
  messages?: { reason: string; line?: number; column?: number; fatal?: boolean | null }[];
  diagnostics?: PluginDiagnostic[];
  errors: string[];
  pending?: boolean;
}
interface Request { key: string; view: string; source: string; file: string; settings: any }
interface Project {
  identity: string; root: string; plugins: { file: string; label: string }[];
  worker: Worker; ready: boolean; errors: string[]; loading?: ReturnType<typeof setTimeout>;
  queue: Request[]; latest: Map<string, string>;
  active?: Request & { id: number; timer: ReturnType<typeof setTimeout>; context?: Partial<PluginDiagnostic> }; failed?: string;
}
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Preserve the canonical root when an entire watched directory was removed.
const canonical = (file: string): string => {
  let parent = path.resolve(file); const tail: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(parent), ...tail); }
    catch { const next = path.dirname(parent); if (next === parent) return path.resolve(file); tail.unshift(path.basename(parent)); parent = next; }
  }
};

/** Async work behind a synchronous Markdown-It render; completed trees trigger refresh. */
export class PreviewPluginManager {
  private projects = new Map<string, Project>();
  private cache = new Map<string, { identity: string; root: string; result: PluginParseResult; bytes: number }>();
  private documents = new Map<string, { identity: string; root: string }>();
  // Worker eviction must not silently retry failed code when other projects open.
  private failures = new Map<string, string>();
  private invalidations = new Map<string, ReturnType<typeof setTimeout>>();
  private cacheBytes = 0;
  private nextId = 0;
  private disposed = false;
  constructor(private readonly changed: () => void, private readonly workerFile = path.join(__dirname, 'preview-plugin-worker.cjs'), private readonly timeoutMs = 2000, private readonly event: (event: PluginEvent) => void = () => {}) {}

  parse(source: string, file: string, root: string, project: any, enabled: boolean, trusted: boolean): PluginParseResult | undefined {
    if (!enabled || !project.plugins || (Array.isArray(project.plugins) && !project.plugins.length)) {
      this.forgetDocument(canonical(file)); return;
    }
    if (!trusted) return { errors: ['MyST project plugins require a trusted local workspace.'] };
    if (this.disposed) return { errors: ['MyST project plugin runtime has stopped.'] };
    const errors: string[] = [], plugins: { file: string; label: string }[] = [];
    if (!Array.isArray(project.plugins)) errors.push('MyST project.plugins must be an array.');
    try { root = fs.realpathSync(root); file = path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); }
    catch { return { errors: ['Cannot resolve the MyST plugin preview root or source folder.'] }; }
    if (!inside(root, file)) return { errors: ['MyST plugin source document is outside the preview root.'] };
    for (const entry of Array.isArray(project.plugins) ? project.plugins : []) {
      const target = typeof entry === 'string' ? entry : entry?.type === 'javascript' ? entry.path : undefined;
      if (typeof target !== 'string' || !target || path.isAbsolute(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || /[\0\\]/.test(target)) {
        errors.push('MyST plugin: expected a relative local JavaScript path in myst.yml.'); continue;
      }
      const candidate = path.resolve(path.dirname(file), target);
      const label = path.relative(root, candidate).split(path.sep).join('/');
      try {
        const resolved = fs.realpathSync(candidate);
        if (!inside(root, candidate) || !inside(root, resolved) || path.relative(root, candidate).split(path.sep).some(part => part.startsWith('.')))
          throw new Error('path is outside the preview root or in an excluded directory.');
        if (!/\.(?:js|mjs)$/.test(resolved)) throw new Error('only JavaScript ESM .js and .mjs plugins are supported.');
        const stat = fs.statSync(resolved);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('plugin must be a file no larger than 2 MiB.');
        if (!plugins.some(plugin => plugin.file === resolved)) plugins.push({ file: resolved, label });
      } catch (error) { errors.push(`MyST plugin ${inside(root, candidate) ? label : '(outside root)'}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const identity = JSON.stringify({ root, plugins });
    const previous = this.documents.get(file);
    if (previous && previous.identity !== identity) {
      this.event({ type: 'diagnostics', project: previous.identity, root: previous.root, file, diagnostics: [] });
      this.event({ type: 'diagnostics', project: previous.identity + ':configuration', root: previous.root, file, diagnostics: [] });
    }
    this.documents.delete(file); this.documents.set(file, { identity, root });
    while (this.documents.size > 256) this.forgetDocument(this.documents.keys().next().value!);
    this.event({ type: 'diagnostics', project: identity + ':configuration', root, file,
      diagnostics: errors.map(reason => ({ phase: 'configuration', reason })) });
    if (!plugins.length) return { errors };
    const key = hash(JSON.stringify({ source, file, settings: project.settings }));
    const view = JSON.stringify({ file, settings: project.settings });
    const cached = this.cache.get(identity + key);
    let runtime = this.projects.get(identity);
    if (runtime) {
      if (!cached && runtime.latest.has(view) && runtime.latest.get(view) !== key) this.report(identity, root, file, { errors: [] });
      runtime.latest.delete(view); runtime.latest.set(view, key);
      if (cached || runtime.active?.key === key) runtime.queue = runtime.queue.filter(request => request.view !== view);
      while (runtime.latest.size > 256) runtime.latest.delete(runtime.latest.keys().next().value!);
    }
    if (cached) {
      this.cache.delete(identity + key); this.cache.set(identity + key, cached);
      this.report(identity, root, file, cached.result);
      return { ...structuredClone(cached.result), errors: [...errors, ...cached.result.errors] };
    }
    const failure = this.failures.get(identity);
    if (failure) return { errors: [...errors, failure] };
    const reject = (reason: string): PluginParseResult => {
      this.report(identity, root, file, { errors: [reason], diagnostics: [{ phase: 'parsing', reason, file }] });
      return { errors: [...errors, reason] };
    };
    if (Buffer.byteLength(source) > 2 * 1024 * 1024) return reject('MyST plugin source exceeds the 2 MiB limit.');
    if (!runtime) {
      if (this.projects.size >= 4) {
        const idle = [...this.projects].find(([, state]) => state.failed || (state.ready && !state.active && !state.queue.length));
        if (!idle) return { pending: true, errors };
        this.stop(idle[1]); this.projects.delete(idle[0]);
      }
      const worker = new Worker(this.workerFile, { workerData: { root, plugins }, resourceLimits: { maxOldGenerationSizeMb: 128 }, stdout: true, stderr: true });
      runtime = { identity, root, plugins, worker, ready: false, errors: [], queue: [], latest: new Map([[view, key]]) };
      const state = runtime;
      this.projects.set(identity, state);
      for (const [level, stream] of [['stdout', worker.stdout], ['stderr', worker.stderr]] as const) {
        stream.setEncoding('utf8');
        stream.on('data', message => {
          if (!this.disposed && this.projects.get(identity) === state) this.event({ type: 'log', root, plugins: plugins.map(plugin => plugin.label), file: state.active?.file, level, message });
        });
      }
      worker.unref();
      this.event({ type: 'log', root, plugins: plugins.map(plugin => plugin.label), level: 'info', message: 'Loading project plugins.' });
      const fail = (reason: string, phase: PluginDiagnostic['phase'], detail?: string) => {
        if (state.failed || this.disposed || this.projects.get(identity) !== state) return;
        const active = state.active;
        const current = active && state.latest.get(active.view) === active.key;
        state.failed = reason; this.failures.set(identity, reason); this.stop(state); state.queue = [];
        this.event({ type: 'diagnostics', project: identity, root, file: active?.file,
          diagnostics: [{ ...active?.context, phase, reason, detail, file: active?.file,
            line: current ? active.context?.line : undefined, column: current ? active.context?.column : undefined }] });
        this.changed();
      };
      state.loading = setTimeout(() => fail('MyST project plugin loading timed out (2 seconds).', 'timeout'), this.timeoutMs);
      worker.on('error', error => fail(`MyST project plugin worker failed: ${error.message}`, state.active ? 'execution' : 'loading', error.stack));
      worker.on('exit', code => fail(`MyST project plugin worker stopped (exit ${code}).`, state.active ? 'execution' : 'loading'));
      worker.on('message', response => {
        if (this.disposed || this.projects.get(identity) !== state || state.failed) return;
        if (response.failed) { fail(`MyST project plugin loading failed: ${response.failed}`, 'loading', response.detail); return; }
        if (response.ready) {
          clearTimeout(state.loading); state.ready = true; state.errors = response.errors;
          this.event({ type: 'diagnostics', project: identity, root, diagnostics: response.diagnostics ?? [] });
          this.dispatch(state); return;
        }
        if (!state.active || state.active.id !== response.id) return;
        if (response.executing) { state.active.context = response.executing; return; }
        clearTimeout(state.active.timer);
        const request = state.active;
        const result: PluginParseResult = response.result ?? { errors: [`MyST project plugin parsing failed: ${response.error}`],
          diagnostics: [{ phase: 'parsing', reason: response.error, detail: response.detail, file: request.file }] };
        const bytes = Buffer.byteLength(JSON.stringify(result));
        this.cache.set(identity + request.key, { identity, root, result, bytes }); this.cacheBytes += bytes;
        state.active = undefined;
        while (this.cache.size > 128 || this.cacheBytes > 32 * 1024 * 1024) {
          const oldest = this.cache.keys().next().value!;
          this.cacheBytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
        }
        if (state.latest.get(request.view) === request.key) { this.report(identity, root, request.file, result); this.changed(); }
        this.dispatch(state);
      });
    }
    if (runtime.failed) return { errors: [...errors, runtime.failed] };
    if (runtime.active?.key !== key && !runtime.queue.some(request => request.key === key)) {
      const queued = runtime.queue.findIndex(request => request.view === view);
      const request = { key, view, source, file, settings: project.settings };
      if (queued >= 0) runtime.queue[queued] = request;
      else {
        if (runtime.queue.length >= 100) return reject('MyST plugin preview queue limit reached.');
        runtime.queue.push(request);
      }
      this.dispatch(runtime);
    }
    return { pending: true, errors: [...errors, ...runtime.errors] };
  }

  private report(identity: string, root: string, file: string, result: PluginParseResult) {
    this.event({ type: 'diagnostics', project: identity, root, file, diagnostics: result.diagnostics ?? [] });
  }
  private dispatch(project: Project) {
    if (!project.ready || project.active || project.failed) return;
    const request = project.queue.shift(); if (!request) return;
    const id = ++this.nextId;
    const timer = setTimeout(() => {
      project.failed = 'MyST project plugin execution timed out (2 seconds).';
      this.failures.set(project.identity, project.failed);
      const context = project.active?.context;
      const current = project.latest.get(request.view) === request.key;
      this.stop(project); project.queue = [];
      this.event({ type: 'diagnostics', project: project.identity, root: project.root, file: request.file,
        diagnostics: [{ ...context, phase: 'timeout', reason: project.failed, file: request.file,
          line: current ? context?.line : undefined, column: current ? context?.column : undefined }] });
      this.changed();
    }, this.timeoutMs);
    project.active = { ...request, id, timer };
    project.worker.postMessage({ id, ...request });
  }

  /** Broad saved-file coverage, but only one invalidation per affected root per burst. */
  scheduleInvalidate(file: string) {
    if (this.disposed) return;
    file = canonical(file);
    const roots = new Set([...this.documents.values()].map(item => item.root));
    for (const project of this.projects.values()) roots.add(project.root);
    for (const cached of this.cache.values()) roots.add(cached.root);
    for (const root of roots) if (inside(root, file)) {
      clearTimeout(this.invalidations.get(root));
      this.invalidations.set(root, setTimeout(() => {
        this.invalidations.delete(root);
        this.clearProjects(identity => JSON.parse(identity).root === root);
        this.event({ type: 'clear', root });
        this.event({ type: 'log', root, plugins: [], level: 'info', message: 'Saved files changed; reloading project plugins.' });
        this.changed();
      }, 300));
    }
  }

  reloadDocument(file: string): boolean {
    const document = this.documents.get(canonical(file));
    if (!document || this.disposed) return false;
    this.clearProjects(identity => identity === document.identity);
    this.event({ type: 'clear', project: document.identity });
    this.event({ type: 'clear', project: document.identity + ':configuration' });
    this.event({ type: 'log', root: document.root, plugins: [], file, level: 'info', message: 'Reload Project Plugins requested.' });
    this.changed(); return true;
  }

  invalidate(file?: string) {
    if (file) file = canonical(file);
    for (const [root, timer] of this.invalidations) if (!file || inside(root, file)) { clearTimeout(timer); this.invalidations.delete(root); }
    this.clearProjects(identity => !file || inside(JSON.parse(identity).root, file));
    if (!file) this.event({ type: 'clear' });
    else for (const root of new Set([...this.documents.values()].map(item => item.root))) if (inside(root, file)) this.event({ type: 'clear', root });
  }
  private clearProjects(matches: (identity: string) => boolean) {
    for (const identity of this.failures.keys()) if (matches(identity)) this.failures.delete(identity);
    for (const [identity, project] of this.projects) if (matches(identity)) { this.projects.delete(identity); this.stop(project); }
    for (const [key, cached] of this.cache) if (matches(cached.identity)) { this.cacheBytes -= cached.bytes; this.cache.delete(key); }
  }
  private forgetDocument(file: string) {
    const document = this.documents.get(file); if (!document) return;
    this.event({ type: 'diagnostics', project: document.identity, root: document.root, file, diagnostics: [] });
    this.event({ type: 'diagnostics', project: document.identity + ':configuration', root: document.root, file, diagnostics: [] });
    this.documents.delete(file);
    if (![...this.documents.values()].some(item => item.identity === document.identity) && !this.projects.has(document.identity)) this.failures.delete(document.identity);
  }
  private stop(project: Project) {
    clearTimeout(project.loading); clearTimeout(project.active?.timer);
    project.active = undefined; void project.worker.terminate();
  }
  dispose() { this.disposed = true; this.invalidate(); this.documents.clear(); }
}
