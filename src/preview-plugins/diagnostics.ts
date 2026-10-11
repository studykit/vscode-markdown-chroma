import * as path from 'node:path';
import type { PluginDiagnostic, PluginEvent } from './events';

interface Report { root: string; file?: string; diagnostics: PluginDiagnostic[]; signature: string; bytes: number }
interface Output { clear(): void; append(value: string): void }

/** Bounded Output history and source-located Problems, independent of VS Code. */
export class PreviewPluginDiagnostics {
  private reports = new Map<string, Report>();
  private reportBytes = 0;
  private logs: string[] = [];
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly output: Output, private readonly publish: (diagnostics: PluginDiagnostic[]) => void) {}

  accept(event: PluginEvent) {
    if (this.disposed) return;
    if (event.type === 'log') {
      const location = event.file ? path.relative(event.root, event.file) : '';
      this.log(`[${event.level}] ${event.root}${location ? ` / ${location}` : ''} [${event.plugins.join(', ')}]\n${event.message}`);
      return;
    }
    if (event.type === 'clear') {
      for (const [key, report] of this.reports) {
        if (event.project ? key.startsWith(event.project + '\0') : !event.root || report.root === event.root) this.remove(key);
      }
    } else {
      const key = event.project + '\0' + (event.file ?? '');
      const bounded = event.diagnostics.slice(0, 200).map(item => ({ ...item, reason: item.reason.slice(0, 4096), detail: item.detail?.slice(0, 8192) }));
      const signature = JSON.stringify({ root: event.root, file: event.file, diagnostics: bounded });
      const next = { root: event.root, file: event.file, diagnostics: bounded, signature, bytes: Buffer.byteLength(signature) };
      const previous = this.reports.get(key);
      if (previous?.signature === signature) return;
      const known = new Set(previous?.diagnostics.map(item => JSON.stringify(item)));
      for (const diagnostic of next.diagnostics) {
        if (known.has(JSON.stringify(diagnostic))) continue;
        const location = diagnostic.file ? path.relative(event.root, diagnostic.file) : '';
        this.log(`[${diagnostic.phase}] ${event.root}${location ? ` / ${location}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ''}` : ''}${diagnostic.plugin ? ` [${diagnostic.plugin}]` : ''}\n${diagnostic.reason}${diagnostic.detail ? `\n${diagnostic.detail}` : ''}`);
      }
      this.remove(key); this.reports.set(key, next); this.reportBytes += next.bytes;
      while (this.reports.size > 256 || this.reportBytes > 4 * 1024 * 1024) this.remove(this.reports.keys().next().value!);
    }
    const located = new Map<string, PluginDiagnostic>();
    for (const report of this.reports.values()) for (const diagnostic of report.diagnostics) {
      if (!diagnostic.file || !Number.isInteger(diagnostic.line) || diagnostic.line! < 1 || !Number.isInteger(diagnostic.column) || diagnostic.column! < 1) continue;
      located.set(JSON.stringify(diagnostic), diagnostic);
    }
    this.publish([...located.values()]);
  }

  private remove(key: string) {
    const report = this.reports.get(key);
    if (report) this.reportBytes -= report.bytes;
    this.reports.delete(key);
  }

  private log(value: string) {
    const buffer = Buffer.from(value);
    let end = Math.min(buffer.length, 8192);
    // Do not split a UTF-8 character at the per-entry limit.
    if (end < buffer.length) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
    const entry = new Date().toISOString() + ' ' + buffer.subarray(0, end).toString('utf8') + '\n';
    this.logs.push(entry); this.bytes += Buffer.byteLength(entry);
    while (this.bytes > 256 * 1024) this.bytes -= Buffer.byteLength(this.logs.shift()!);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 100);
  }

  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    this.output.clear(); this.output.append(this.logs.join(''));
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.reports.clear(); this.publish([]); }
}
