import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

export interface PluginParseResult {
  tree?: any;
  messages?: { reason: string; line?: number; column?: number; fatal?: boolean | null }[];
  errors: string[];
  pending?: boolean;
}
interface Project {
  worker: Worker; ready: boolean; errors: string[]; loading?: ReturnType<typeof setTimeout>;
  queue: { key: string; source: string; file: string; settings: any }[];
  active?: { id: number; key: string; timer: ReturnType<typeof setTimeout> }; failed?: string;
}
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Async work behind a synchronous Markdown-It render; completed trees trigger refresh. */
export class PreviewPluginManager {
  private projects = new Map<string, Project>();
  private cache = new Map<string, { identity: string; root: string; result: PluginParseResult; bytes: number }>();
  private cacheBytes = 0;
  private nextId = 0;
  private disposed = false;
  constructor(private readonly changed: () => void, private readonly workerFile = path.join(__dirname, 'preview-plugin-worker.cjs'), private readonly timeoutMs = 2000) {}

  parse(source: string, file: string, root: string, project: any, enabled: boolean, trusted: boolean): PluginParseResult | undefined {
    if (!project.plugins || (Array.isArray(project.plugins) && !project.plugins.length)) return;
    if (!enabled) return; // Existing unsupported-directive path remains the default.
    if (!trusted) return { errors: ['MyST project plugins require a trusted local workspace.'] };
    if (this.disposed) return { errors: ['MyST project plugin runtime has stopped.'] };
    if (!Array.isArray(project.plugins)) return { errors: ['MyST project.plugins must be an array.'] };
    const errors: string[] = [], plugins: { file: string; label: string }[] = [];
    try { root = fs.realpathSync(root); file = path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); }
    catch { return { errors: ['Cannot resolve the MyST plugin preview root or source folder.'] }; }
    if (!inside(root, file)) return { errors: ['MyST plugin source document is outside the preview root.'] };
    for (const entry of project.plugins) {
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
    if (!plugins.length) return { errors };
    const identity = JSON.stringify({ root, plugins });
    const key = hash(JSON.stringify({ source, file, settings: project.settings }));
    const cacheKey = identity + key;
    const cached = this.cache.get(cacheKey);
    // Keep completed results across worker eviction. Otherwise more than four
    // projects in one render could repeatedly evict each other's pending work.
    if (cached) {
      this.cache.delete(cacheKey); this.cache.set(cacheKey, cached);
      return { ...structuredClone(cached.result), errors: [...errors, ...cached.result.errors] };
    }
    if (Buffer.byteLength(source) > 2 * 1024 * 1024) return { errors: [...errors, 'MyST plugin source exceeds the 2 MiB limit.'] };
    let runtime = this.projects.get(identity);
    if (!runtime) {
      // Bound both workers and AST caches during multi-project preview use.
      if (this.projects.size >= 4) {
        const idle = [...this.projects].find(([, state]) => state.failed || (state.ready && !state.active && !state.queue.length));
        if (!idle) return { pending: true, errors };
        this.stop(idle[1]); this.projects.delete(idle[0]);
      }
      const worker = new Worker(this.workerFile, { workerData: { root, plugins }, resourceLimits: { maxOldGenerationSizeMb: 128 }, stdout: true, stderr: true });
      // Project console output is isolated from extension and MCP streams.
      worker.stdout.resume(); worker.stderr.resume(); worker.unref();
      runtime = { worker, ready: false, errors: [], queue: [] };
      const state = runtime;
      const fail = (reason: string) => {
        if (state.failed || this.disposed || this.projects.get(identity) !== state) return;
        state.failed = reason; this.stop(state); state.queue = []; this.changed();
      };
      state.loading = setTimeout(() => fail('MyST project plugin loading timed out (2 seconds).'), this.timeoutMs);
      worker.on('error', error => fail(`MyST project plugin worker failed: ${error.message}`));
      worker.on('exit', code => fail(`MyST project plugin worker stopped (exit ${code}).`));
      worker.on('message', response => {
        if (this.disposed || this.projects.get(identity) !== state || state.failed) return;
        if (response.failed) { fail(`MyST project plugin loading failed: ${response.failed}`); return; }
        if (response.ready) { clearTimeout(state.loading); state.ready = true; state.errors = response.errors; this.dispatch(state); return; }
        if (!state.active || state.active.id !== response.id) return;
        clearTimeout(state.active.timer);
        const result = response.result ?? { errors: [`MyST project plugin parsing failed: ${response.error}`] };
        const bytes = Buffer.byteLength(JSON.stringify(result));
        this.cache.set(identity + state.active.key, { identity, root, result, bytes }); this.cacheBytes += bytes;
        state.active = undefined;
        while (this.cache.size > 128 || this.cacheBytes > 32 * 1024 * 1024) {
          const oldest = this.cache.keys().next().value!;
          this.cacheBytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
        }
        this.changed(); this.dispatch(state);
      });
      this.projects.set(identity, runtime);
    }
    if (runtime.failed) return { errors: [...errors, runtime.failed] };
    if (runtime.active?.key !== key && !runtime.queue.some(request => request.key === key)) {
      if (runtime.queue.length >= 100) return { errors: [...errors, 'MyST plugin preview queue limit reached.'] };
      runtime.queue.push({ key, source, file, settings: project.settings });
      this.dispatch(runtime);
    }
    return { pending: true, errors: [...errors, ...runtime.errors] };
  }

  private dispatch(project: Project) {
    if (!project.ready || project.active || project.failed) return;
    const request = project.queue.shift(); if (!request) return;
    const id = ++this.nextId;
    const timer = setTimeout(() => {
      project.failed = 'MyST project plugin execution timed out (2 seconds).';
      this.stop(project); project.queue = []; this.changed();
    }, this.timeoutMs);
    project.active = { id, key: request.key, timer };
    project.worker.postMessage({ id, ...request });
  }

  invalidate(file?: string) {
    if (file) {
      try { file = fs.realpathSync(file); }
      catch { try { file = path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); } catch { file = undefined; } }
    }
    for (const [key, project] of this.projects) {
      if (file && !inside(JSON.parse(key).root, file)) continue;
      this.stop(project); this.projects.delete(key);
    }
    for (const [key, cached] of this.cache) {
      if (file && !inside(cached.root, file)) continue;
      this.cacheBytes -= cached.bytes; this.cache.delete(key);
    }
  }
  private stop(project: Project) {
    clearTimeout(project.loading); clearTimeout(project.active?.timer);
    project.active = undefined;
    void project.worker.terminate();
  }
  dispose() { this.disposed = true; this.invalidate(); }
}
