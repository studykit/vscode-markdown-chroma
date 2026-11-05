import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { aliasesFrom } from './frontmatter';
import { previewReferenceIdentifiers } from './preview-reference-index';
import type { Resolution } from './types';

const ignored = new Set(['.git', '.obsidian', 'node_modules']);
const maxNoteBytes = 2 * 1024 * 1024;
const key = (value: string) => value.normalize('NFC').toLocaleLowerCase();

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolvePreviewRoot(source: string, workspaceRoot?: string, configuredRoot = ''): string {
  const fallback = workspaceRoot ?? path.dirname(source);
  if (configuredRoot) {
    const configured = path.resolve(fallback, configuredRoot);
    if (isWithin(fallback, configured) && isWithin(configured, source)) {
      try {
        if (fs.statSync(configured).isDirectory() && isWithin(fs.realpathSync(fallback), fs.realpathSync(configured))) return configured;
      } catch { /* Invalid roots fall back to the document's workspace or folder. */ }
    }
  }
  return fallback;
}

/** One immutable lookup snapshot per local vault. Contents are read on demand. */
export class FileVault {
  private files = new Map<string, string>();
  private names = new Map<string, string[]>();
  private aliases = new Map<string, string[]>();
  private cached = new Map<string, { signature: string; source: string }>();
  private generation = 0;
  private referenceRecords = new Map<string, { signature: string; identifiers: Set<string> }>();

  constructor(readonly root: string, private readonly dirtyText: (file: string) => string | undefined = () => undefined) {}

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const files = new Map<string, string>();
    const names = new Map<string, string[]>();
    const aliases = new Map<string, string[]>();
    const referenceRecords = new Map<string, { signature: string; identifiers: Set<string> }>();
    const add = (map: Map<string, string[]>, name: string, file: string) => {
      const normalized = key(name);
      map.set(normalized, [...(map.get(normalized) ?? []), file]);
    };
    const walk = async (directory: string): Promise<void> => {
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (ignored.has(entry.name) || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { await walk(file); continue; }
        if (!entry.isFile()) continue;
        files.set(key(path.relative(this.root, file).split(path.sep).join('/')), file);
        add(names, entry.name, file);
        if (path.extname(file).toLowerCase() !== '.md') continue;
        add(names, entry.name.slice(0, -3), file);
        let handle: fs.promises.FileHandle | undefined;
        try {
          // Only the header is needed for alias indexing, even for large notes.
          handle = await fs.promises.open(file, 'r');
          const buffer = Buffer.alloc(64 * 1024);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const source = this.dirtyText(file) ?? buffer.subarray(0, bytesRead).toString('utf8');
          for (const alias of aliasesFrom(source)) add(aliases, alias, file);
        } catch { /* An unreadable note can still be linked. */ }
        finally { await handle?.close(); }
        const record = this.referenceRecord(file);
        if (record) referenceRecords.set(file, record);
        // A project can contain hundreds of Markdown files. Yield between
        // documents instead of doing project discovery inside a render budget.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    await walk(this.root);
    if (generation !== this.generation) return;
    this.files = files;
    this.names = names;
    this.aliases = aliases;
    this.referenceRecords = referenceRecords;
    this.cached.clear();
  }

  resolve(target: string, source?: string): Resolution {
    if (!source || !isWithin(this.root, source)) return { status: 'outside' };
    if (!target) return this.safeFile(source) ? { status: 'found', path: source } : { status: 'missing' };
    if (/[\0\\]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target) || path.isAbsolute(target)) return { status: 'outside' };
    const withExtension = path.extname(target) ? [target] : [`${target}.md`, target];
    const explicitRelative = target.startsWith('./') || target.startsWith('../');
    const base = explicitRelative ? path.dirname(source) : this.root;
    for (const candidate of withExtension) {
      const absolute = path.resolve(base, candidate);
      if (!isWithin(this.root, absolute)) return { status: 'outside' };
    }

    if (!target.includes('/')) {
      for (const candidate of withExtension) {
        const local = path.resolve(path.dirname(source), candidate);
        const found = this.lookup(local);
        if (found) return { status: 'found', path: found };
      }
    }
    for (const candidate of withExtension) {
      const found = this.lookup(path.resolve(base, candidate));
      if (found) return { status: 'found', path: found };
    }
    if (target.includes('/')) return { status: 'missing' };
    const candidates = [...new Set(this.names.get(key(target)) ?? this.aliases.get(key(target)) ?? [])]
      .filter(file => this.safeFile(file));
    if (candidates.length === 1) return { status: 'found', path: candidates[0] };
    if (candidates.length > 1) return { status: 'ambiguous', candidates: candidates.sort() };
    return { status: 'missing' };
  }

  read(file: string): string | undefined {
    if (!this.safeFile(file)) return;
    const dirty = this.dirtyText(file);
    if (dirty !== undefined) return Buffer.byteLength(dirty) <= maxNoteBytes ? dirty : undefined;
    try {
      const stat = fs.statSync(file);
      if (stat.size > maxNoteBytes) return;
      const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      const cached = this.cached.get(file);
      if (cached?.signature === signature) return cached.source;
      const source = fs.readFileSync(file, 'utf8');
      if (this.cached.size >= 100) this.cached.clear();
      this.cached.set(file, { signature, source });
      return source;
    } catch { return; }
  }

  *markdownFiles(source: string): Iterable<string> {
    if (!isWithin(this.root, source)) return;
    for (const file of this.files.values()) {
      if (path.extname(file).toLowerCase() === '.md' && this.safeFile(file)) yield file;
    }
  }

  *referenceFiles(identifier: string, source: string): Iterable<string> {
    for (const file of this.markdownFiles(source)) {
      // Recheck signatures here too: dirty buffers and saves can precede the
      // next debounced project refresh. Unrelated documents are not reparsed.
      if (this.referenceRecord(file)?.identifiers.has(identifier)) yield file;
    }
  }

  private referenceRecord(file: string) {
    if (!this.safeFile(file)) return;
    try {
      const dirty = this.dirtyText(file);
      const stat = fs.statSync(file);
      const signature = dirty === undefined ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
        : `dirty:${createHash('sha256').update(dirty).digest('hex')}`;
      const cached = this.referenceRecords.get(file);
      if (cached?.signature === signature) return cached;
      const source = this.read(file);
      const record = { signature, identifiers: source === undefined ? new Set<string>() : previewReferenceIdentifiers(source) };
      this.referenceRecords.set(file, record);
      return record;
    } catch { return; }
  }

  updateAliases(file: string, source: string): void {
    if (!isWithin(this.root, file)) return;
    for (const [alias, files] of this.aliases) {
      const remaining = files.filter(candidate => candidate !== file);
      if (remaining.length) this.aliases.set(alias, remaining); else this.aliases.delete(alias);
    }
    for (const alias of aliasesFrom(source)) {
      const normalized = key(alias);
      this.aliases.set(normalized, [...new Set([...(this.aliases.get(normalized) ?? []), file])]);
    }
  }

  private lookup(file: string): string | undefined {
    const match = this.files.get(key(path.relative(this.root, file).split(path.sep).join('/')));
    return match && this.safeFile(match) ? match : undefined;
  }

  private safeFile(file: string): boolean {
    try {
      return isWithin(this.root, file) && isWithin(fs.realpathSync(this.root), fs.realpathSync(file)) && fs.statSync(file).isFile();
    } catch { return false; }
  }
}
