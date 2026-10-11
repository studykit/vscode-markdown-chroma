import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { Cite } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import { parseDocument } from 'yaml';
import { parseFrontmatter } from '../frontmatter';
import { normalizeLabel } from 'myst-common';
import { mystConfiguration, mergeSettings } from '../myst-config';
import { isWithin } from '../vault';
import { extract, hash, parseIndex } from './parser';
import { isExcludedIndexPath } from './paths';
import { IndexError, PARSER_VERSION, SCHEMA_VERSION, type ContentItem, type Diagnostic, type DocumentIndex, type ProjectIndex, type Reference, type Resolution, type Section } from './types';

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const key = (value: string) => value.normalize('NFC').toLowerCase();
const portable = (value: string) => value.split(path.sep).join('/');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export function defaultCacheDirectory(): string {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches') : process.platform === 'win32'
    ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local') : process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'markdown-chroma');
}

/** A query uses one saved-file snapshot. No editor, .obsidian config, rendering, execution or downloads. */
export class MarkdownIndex {
  readonly root: string;
  readonly cacheFile: string;
  data!: ProjectIndex;
  private files = new Set<string>();
  private scanDiagnostics: Diagnostic[] = [];
  private normalizedFiles = new Map<string, string[]>();
  private readonly cacheDirectory: string;
  private names = new Map<string, string[]>();
  stats = { parsed: 0, reused: 0, removed: 0 };

  constructor(root = process.cwd(), cacheDirectory = defaultCacheDirectory()) {
    try {
      this.root = fs.realpathSync(path.resolve(root));
      if (!fs.statSync(this.root).isDirectory()) throw new Error('Not a directory.');
    } catch (error) { throw new IndexError('invalidRoot', `Cannot open root: ${errorMessage(error)}`); }
    this.cacheFile = path.join(path.resolve(cacheDirectory), hash(this.root).slice(7), 'index.json');
    let ancestor = path.resolve(cacheDirectory); const missing: string[] = [];
    for (;;) {
      try { this.cacheDirectory = path.join(fs.realpathSync(ancestor), ...missing.reverse()); break; }
      catch {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) { this.cacheDirectory = path.resolve(cacheDirectory); break; }
        missing.push(path.basename(ancestor)); ancestor = parent;
      }
    }
  }
  get complete() { return !this.data.diagnostics.length && !this.data.documents.some(d => d.diagnostics.length); }
  get diagnostics() { return [...this.data.diagnostics, ...this.data.documents.flatMap(d => d.diagnostics)]; }

  private scan(directory: string, cacheDirectory = this.cacheDirectory): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { this.scanDiagnostics.push({ code: 'directoryReadFailed', file: portable(path.relative(this.root, directory)), message: errorMessage(error), severity: 'error' }); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const absolute = path.join(directory, entry.name);
      // Custom caches inside the root are never indexed as source files.
      if (entry.isSymbolicLink() || isExcludedIndexPath(this.root, absolute, cacheDirectory)) continue;
      if (entry.isDirectory()) this.scan(absolute, cacheDirectory);
      else if (entry.isFile()) this.files.add(portable(path.relative(this.root, absolute)));
    }
  }

  private readFile(file: string): string {
    if (!this.files.has(file)) throw new IndexError('fileNotFound', `File is not in the indexed root: ${file}`);
    return this.readSourceFile(file);
  }

  private readSourceFile(file: string): string {
    const absolute = path.resolve(this.root, file);
    if (!isWithin(this.root, absolute)) throw new IndexError('outsideRoot', `File is outside the root: ${file}`);
    let handle: number | undefined;
    try {
      if (fs.realpathSync(absolute) !== absolute) throw new IndexError('outsideRoot', `Symlink paths are excluded: ${file}`);
      handle = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const before = fs.fstatSync(handle);
      if (!before.isFile()) throw new IndexError('fileReadFailed', `Not a regular file: ${file}`);
      if (before.size > MAX_DOCUMENT_BYTES) throw new IndexError('fileTooLarge', `File exceeds the 2 MiB limit: ${file}`);
      const buffer = Buffer.alloc(before.size + 1);
      let size = 0, bytes = 0;
      while (size < buffer.length && (bytes = fs.readSync(handle, buffer, size, buffer.length - size, null)) > 0) size += bytes;
      const after = fs.fstatSync(handle);
      if (size > MAX_DOCUMENT_BYTES) throw new IndexError('fileTooLarge', `File exceeds the 2 MiB limit: ${file}`);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size !== after.size) throw new IndexError('documentChanged', `File changed while reading: ${file}`);
      const content = buffer.subarray(0, size);
      if (!isUtf8(content)) throw new IndexError('invalidEncoding', `File is not valid UTF-8: ${file}`);
      return content.toString('utf8');
    } catch (error) {
      if (error instanceof IndexError) throw error;
      throw new IndexError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'fileNotFound' : 'fileReadFailed', `Cannot read saved file: ${file}`);
    } finally { if (handle !== undefined) fs.closeSync(handle); }
  }

  private config(file: string) {
    const config = mystConfiguration({
      resolve: (target, source) => {
        if (!source || /[\0\\]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || path.isAbsolute(target)) return { status: 'outside' };
        const absolute = path.resolve(path.dirname(source), target);
        if (!isWithin(this.root, absolute)) return { status: 'outside' };
        const relative = portable(path.relative(this.root, absolute));
        return this.files.has(relative) ? { status: 'found', path: absolute } : { status: 'missing' };
      },
      read: absolute => { try { return this.readFile(portable(path.relative(this.root, absolute))); } catch { return undefined; } },
      documentUri: absolute => ({ fsPath: absolute }), resourceUri: absolute => absolute, settings: () => ({ maxEmbedDepth: 1 }),
    }, { currentDocument: { fsPath: path.join(this.root, file) } });
    return config;
  }

  private bibliography(settings: Record<string, any>, file: string): { keys: string[]; fingerprint: string; diagnostics: Diagnostic[] } {
    const entries = Array.isArray(settings.bibliography) ? settings.bibliography : settings.bibliography ? [settings.bibliography] : [];
    const keys: string[] = [], fingerprints: string[] = [], diagnostics: Diagnostic[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      const relative = portable(path.relative(this.root, path.resolve(this.root, path.dirname(file), entry)));
      if (!isWithin(this.root, path.resolve(this.root, relative)) || !this.files.has(relative)) {
        diagnostics.push({ code: 'bibliographyUnavailable', file, message: `Cannot read local bibliography: ${entry}`, severity: 'warning' }); continue;
      }
      try {
        const source = this.readFile(relative); fingerprints.push(hash(source));
        let records: any[];
        if (/\.bib$/i.test(entry)) records = new Cite(source).data;
        else { const data = /\.json$/i.test(entry) ? JSON.parse(source) : parseDocument(source).toJS({ maxAliasCount: 50 }); records = Array.isArray(data) ? data : []; }
        keys.push(...records.map(record => record['citation-key'] ?? record.id).filter((v): v is string => typeof v === 'string').map(key));
      } catch (error) { diagnostics.push({ code: 'invalidBibliography', file, message: errorMessage(error), severity: 'warning' }); }
    }
    return { keys: [...new Set(keys)], fingerprint: hash(JSON.stringify(fingerprints)), diagnostics };
  }

  private loadCache(): ProjectIndex | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (data.schemaVersion !== SCHEMA_VERSION || data.parserVersion !== PARSER_VERSION || data.root !== this.root || !Number.isSafeInteger(data.generation) || !Array.isArray(data.documents) || !Array.isArray(data.diagnostics)) return;
      for (const doc of data.documents) {
        if (typeof doc.file !== 'string' || typeof doc.sourceHash !== 'string' || typeof doc.configHash !== 'string' || !doc.properties || typeof doc.properties !== 'object') return;
        for (const field of ['sections', 'tables', 'images', 'glossaries', 'terms', 'targets', 'outgoing', 'aliases', 'tags', 'diagnostics', 'bibliographyKeys']) if (!Array.isArray(doc[field])) return;
        for (const field of ['sections', 'tables', 'images', 'glossaries', 'terms', 'targets', 'outgoing']) for (const item of doc[field]) if (!Number.isSafeInteger(item.startLine) || !Number.isSafeInteger(item.endLine) || item.startLine < 1 || item.endLine < item.startLine) return;
      }
      return data;
    } catch { return; }
  }

  private async lock(signal?: AbortSignal): Promise<() => void> {
    const directory = path.dirname(this.cacheFile);
    try { fs.mkdirSync(directory, { recursive: true }); }
    catch (error) { throw new IndexError('cacheWriteFailed', errorMessage(error)); }
    const lock = path.join(directory, 'lock'); const owner = randomUUID();
    const deadline = Date.now() + 15_000;
    while (true) {
      signal?.throwIfAborted();
      try {
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, owner }));
        return () => {
          try { if (JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).owner === owner) fs.rmSync(lock, { recursive: true }); } catch { /* Another process may have cleaned a stale lock. */ }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new IndexError('cacheWriteFailed', errorMessage(error));
        // Serialize stale-lock recovery and re-read the owner under that guard. A second recovery
        // process must not remove the live lock acquired after the first recovery completed.
        const reclaim = path.join(directory, 'reclaim');
        let claiming = false;
        try {
          fs.mkdirSync(reclaim); claiming = true;
          try {
            const state = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
            try { process.kill(state.pid, 0); }
            catch (processError) { if ((processError as NodeJS.ErrnoException).code === 'ESRCH') fs.rmSync(lock, { recursive: true, force: true }); }
          } catch { if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { recursive: true, force: true }); }
        } catch {
          try { if (Date.now() - fs.statSync(reclaim).mtimeMs > 30_000) fs.rmSync(reclaim, { recursive: true, force: true }); } catch { /* Retry. */ }
        } finally { if (claiming) fs.rmSync(reclaim, { recursive: true, force: true }); }
        if (Date.now() > deadline) throw new IndexError('cacheLocked', 'Another CLI process is still updating this root.');
        await delay(50, undefined, { signal });
      }
    }
  }

  async refresh(rebuild = false, signal?: AbortSignal): Promise<void> {
    const release = await this.lock(signal);
    try {
      this.files.clear(); this.scanDiagnostics = []; this.stats = { parsed: 0, reused: 0, removed: 0 };
      this.scan(this.root);
      const previous = rebuild ? undefined : this.loadCache();
      const old = new Map(previous?.documents.map(document => [document.file, document]) ?? []);
      const documents: DocumentIndex[] = [];
      for (const file of [...this.files].sort()) {
        if (!/\.(?:md|markdown)$/i.test(file)) continue;
        const cached = old.get(file); old.delete(file);
        try {
          const source = this.readFile(file);
          const signature = fs.statSync(path.join(this.root, file), { bigint: true });
          const config = this.config(file);
          const frontmatter = parseDocumentForConfig(source);
          const settings = mergeSettings(config.project, frontmatter);
          const bib = this.bibliography(settings, file);
          const configHash = hash(JSON.stringify([settings, config.error, bib.fingerprint, bib.diagnostics]));
          let document: DocumentIndex;
          if (cached?.sourceHash === hash(source) && cached.configHash === configHash) { document = structuredClone(cached); this.stats.reused++; }
          else {
            document = parseIndex(file, source, settings); this.stats.parsed++;
            if (config.error) document.diagnostics.push({ code: 'invalidConfig', message: config.error, file, severity: 'error' });
            document.diagnostics.push(...bib.diagnostics); document.bibliographyKeys = bib.keys;
          }
          document.configHash = configHash; document.signature = `${signature.ino}:${signature.size}:${signature.mtimeNs}:${signature.ctimeNs}`;
          documents.push(document);
        } catch (error) {
          const document: DocumentIndex = { file, sourceHash: '', signature: '', configHash: '', properties: {}, aliases: [], tags: [], sections: [], tables: [], images: [], glossaries: [], terms: [], targets: [], outgoing: [], bibliographyKeys: [],
            diagnostics: [{ code: error instanceof IndexError ? error.code : 'fileReadFailed', message: errorMessage(error), file, severity: 'error' }] };
          documents.push(document);
        }
      }
      this.stats.removed = old.size;
      this.data = { schemaVersion: SCHEMA_VERSION, parserVersion: PARSER_VERSION, root: this.root, generation: previous?.generation ?? 0, documents, diagnostics: this.scanDiagnostics };
      this.buildLookups(); this.resolveReferences();
      const unchanged = previous && JSON.stringify({ ...previous, generation: 0 }) === JSON.stringify({ ...this.data, generation: 0 });
      if (!unchanged) {
        this.data.generation = (previous?.generation ?? this.loadCache()?.generation ?? 0) + 1;
        const temporary = `${this.cacheFile}.${process.pid}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temporary, JSON.stringify(this.data), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.cacheFile);
        } catch (error) { throw new IndexError('cacheWriteFailed', `Cannot save index: ${errorMessage(error)}`); }
        finally { fs.rmSync(temporary, { force: true }); }
      }
    } finally { release(); }
  }

  private buildLookups() {
    this.normalizedFiles.clear(); this.names.clear();
    const add = (map: Map<string, string[]>, name: string, file: string) => map.set(key(name), [...new Set([...(map.get(key(name)) ?? []), file])]);
    for (const file of this.files) {
      add(this.normalizedFiles, file, file); add(this.names, path.posix.basename(file), file);
      if (/\.(md|markdown)$/i.test(file)) add(this.names, path.posix.basename(file).replace(/\.(md|markdown)$/i, ''), file);
    }
    for (const document of this.data.documents) for (const alias of document.aliases) add(this.names, alias, document.file);
  }
  resolveFile(target: string, source: string, wiki = false): Resolution {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return { status: 'external' };
    try { target = decodeURIComponent(target); } catch { /* Literal malformed escapes can still match filenames. */ }
    target = target.split('?')[0];
    if (/[\0\\]/.test(target) || path.posix.isAbsolute(target)) return { status: 'outside' };
    if (!target) return this.files.has(source) ? { status: 'found', file: source } : { status: 'missing' };
    const candidates = path.posix.extname(target)
      ? wiki && !/\.(?:md|markdown)$/i.test(target) ? [target, target + '.md', target + '.markdown'] : [target]
      : [target + '.md', target + '.markdown', target];
    const choose = (files: string[]): Resolution | undefined => files.length === 1 ? { status: 'found', file: files[0] } : files.length > 1 ? { status: 'ambiguous', candidates: files.sort() } : undefined;
    const lookup = (base: string) => {
      for (const candidate of candidates) {
        const relative = path.posix.normalize(path.posix.join(base, candidate));
        if (relative === '..' || relative.startsWith('../')) return { status: 'outside' } as Resolution;
        const result = choose(this.normalizedFiles.get(key(relative)) ?? []); if (result) return result;
      }
    };
    if (!wiki || target.startsWith('./') || target.startsWith('../')) return lookup(path.posix.dirname(source)) ?? { status: 'missing' };
    if (!target.includes('/')) { const local = lookup(path.posix.dirname(source)); if (local) return local; }
    const root = lookup('.'); if (root) return root;
    if (target.includes('/')) return { status: 'missing' };
    return choose(this.names.get(key(target)) ?? []) ?? { status: 'missing' };
  }

  private labelResolution(identifier: string, source?: string): Resolution {
    let matches = this.data.documents.flatMap(document => document.targets.filter(target => target.identifier === identifier).map(target => ({ file: document.file, target })));
    const explicit = matches.filter(match => !match.target.implicit);
    const local = matches.filter(match => match.file === source);
    matches = explicit.length ? explicit : local.length ? local : matches;
    if (matches.length === 1) return { status: 'found', file: matches[0].file, targetKind: matches[0].target.kind, targetId: matches[0].target.id ?? undefined, fragmentStatus: 'found' };
    if (matches.length > 1) return { status: 'ambiguous', candidates: matches.map(m => `${m.file}#${m.target.label}`) };
    return { status: 'missing' };
  }
  private resolveReferences() {
    for (const document of this.data.documents) {
      for (const reference of document.outgoing) {
        let result: Resolution;
        if (reference.kind === 'term') {
          const terms = this.data.documents.flatMap(d => d.terms).filter(term => term.identifier === reference.target);
          result = terms.length === 1 ? { status: 'found', file: terms[0].file, targetKind: 'term', targetId: terms[0].id, fragmentStatus: 'found' }
            : terms.length ? { status: 'ambiguous', candidates: terms.map(t => t.id) } : { status: 'missing' };
        } else if (reference.kind === 'ref') result = this.labelResolution(reference.target, document.file);
        else if (reference.kind === 'link' && !reference.target && reference.fragment !== null) {
          let fragment = reference.fragment;
          try { fragment = decodeURIComponent(fragment); } catch { /* Preserve literal malformed escapes. */ }
          const identifier = normalizeLabel(fragment)?.identifier;
          const explicit = identifier && this.data.documents.some(d => d.targets.some(t => !t.implicit && t.identifier === identifier));
          // Text-bearing MyST links can select project labels. Ordinary heading fragments stay local.
          result = explicit ? this.labelResolution(identifier, document.file) : this.resolveFile('', document.file);
        }
        else if (reference.kind === 'citation') {
          result = document.bibliographyKeys.includes(key(reference.target)) ? { status: 'citation' } : this.labelResolution(reference.target, document.file);
        } else if (reference.kind === 'embed' && reference.syntax === 'myst' && (!reference.target || (!reference.target.includes('/') && !reference.target.includes('.') && !reference.target.includes(':') && !reference.fragment))) {
          result = this.labelResolution(normalizeLabel(reference.fragment ?? reference.target)?.identifier ?? '', document.file);
          if (result.status === 'missing') result = this.resolveFile(reference.target, document.file);
        } else result = this.resolveFile(reference.target, document.file, reference.syntax === 'obsidian');
        if (result.status === 'found' && reference.fragment !== null && result.file) {
          const target = this.data.documents.find(d => d.file === result.file);
          const fragment = (() => { try { return decodeURIComponent(reference.fragment!); } catch { return reference.fragment!; } })();
          if (fragment.startsWith('^') || !target) result.fragmentStatus = 'notIndexed';
          else {
            const headingParts = fragment.split('#');
            const exact = target?.sections.filter(section => section.id === fragment) ?? [];
            const sections = exact.length ? exact : target?.sections.filter(section => key(section.headingPath.slice(-headingParts.length).join('#')) === key(fragment) || section.labels.some(label => normalizeLabel(label)?.identifier === normalizeLabel(fragment)?.identifier)) ?? [];
            const labels = target?.targets.filter(t => t.identifier === normalizeLabel(fragment)?.identifier && t.kind !== 'section') ?? [];
            if (sections.length + labels.length === 1) {
              result.fragmentStatus = 'found'; result.targetKind = sections.length ? 'section' : labels[0].kind; result.targetId = sections[0]?.id ?? labels[0]?.id ?? undefined;
            } else result.fragmentStatus = sections.length + labels.length > 1 ? 'ambiguous' : 'missing';
          }
        }
        reference.resolution = result;
      }
      for (const image of document.images) image.resolution = this.resolveFile(image.source.split('#')[0], document.file, image.syntax === 'obsidian-embed');
    }
  }

  document(file: string): DocumentIndex {
    if (path.isAbsolute(file) || /[\0\\]/.test(file)) throw new IndexError('invalidFile', 'File arguments must be root-relative paths.');
    file = path.posix.normalize(file);
    if (file === '..' || file.startsWith('../')) throw new IndexError('outsideRoot', 'File is outside the root.');
    const document = this.data.documents.find(d => d.file === file);
    if (!document) throw new IndexError('fileNotFound', `Markdown file is not indexed: ${file}`);
    return document;
  }
  section(document: DocumentIndex, id?: string, label?: string, title?: string, headingPath?: string[]): Section {
    if (title !== undefined || headingPath !== undefined) {
      const pathKey = (section: Section) => JSON.stringify(section.headingPath);
      const matches = document.sections.filter(section => title !== undefined ? section.title === title : pathKey(section) === JSON.stringify(headingPath));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        const paths = new Map<string, number>();
        for (const section of matches) paths.set(pathKey(section), (paths.get(pathKey(section)) ?? 0) + 1);
        const candidates = matches.map(section => ({ title: section.title, headingPath: section.headingPath,
          ...(paths.get(pathKey(section))! > 1 ? { id: section.id } : {}) }));
        throw new IndexError('ambiguousSection', 'Multiple sections match. Select a headingPath, or an id when paths are identical.', candidates);
      }
      throw new IndexError('sectionNotFound', 'Section was not found. List its titles again.');
    }
    const matches = document.sections.filter(section => id ? section.id === id : section.labels.some(value => normalizeLabel(value)?.identifier === normalizeLabel(label)?.identifier));
    if (matches.length > 1) throw new IndexError('ambiguousSection', 'Multiple sections have this label.', matches);
    if (matches.length === 1) return matches[0];
    const targets = document.targets.filter(target => target.identifier === normalizeLabel(label)?.identifier);
    const implicit = targets.filter(target => target.implicit && target.kind === 'section');
    if (implicit.length === 1) return document.sections.find(section => section.id === implicit[0].id)!;
    if (implicit.length > 1) throw new IndexError('ambiguousSection', 'Multiple sections have this implicit label.', implicit);
    throw new IndexError(targets.length ? 'notASection' : 'sectionNotFound', targets.length ? 'This label selects a content block.' : 'Section was not found.', targets.length ? targets : undefined);
  }
  sectionAtLine(document: DocumentIndex, line: number): Section {
    const section = document.sections.find(section => section.startLine <= line && section.ownEndLine >= line);
    if (!section) throw new IndexError('notASection', 'This line has no indexed section. Use read-lines for source or read-frontmatter for YAML.');
    return section;
  }
  read(item: Pick<ContentItem, 'file' | 'sourceHash' | 'startLine' | 'endLine'>, sourceHash?: string, endLine = item.endLine): string {
    const source = this.savedSource(item, sourceHash);
    return extract(source, item.startLine, endLine);
  }
  private savedSource(item: { file: string; sourceHash: string }, sourceHash?: string): string {
    const source = this.readFile(item.file);
    if (hash(source) !== item.sourceHash || (sourceHash && sourceHash !== item.sourceHash)) throw new IndexError('documentChanged', `Document changed; list its items again: ${item.file}`);
    return source;
  }
  readFrontmatter(document: DocumentIndex, sourceHash?: string) {
    const source = this.savedSource(document, sourceHash), endLine = parseFrontmatter(source)?.endLine ?? 0;
    return { startLine: 1, endLine, content: endLine ? extract(source, 1, endLine) : '' };
  }
  private sourcePath(file: string): string {
    if (path.isAbsolute(file) || /[\0\\]/.test(file)) throw new IndexError('invalidFile', 'File arguments must be root-relative paths.');
    file = path.posix.normalize(file);
    if (file === '..' || file.startsWith('../')) throw new IndexError('outsideRoot', 'File is outside the root.');
    if (!/\.(?:md|markdown)$/i.test(file) || isExcludedIndexPath(this.root, path.resolve(this.root, file), this.cacheDirectory))
      throw new IndexError('fileNotFound', `Markdown file is excluded from the root: ${file}`);
    return file;
  }
  readLines(args: { file: string; startLine: number; endLine?: number; sourceHash?: string }) {
    const file = this.sourcePath(args.file), source = this.readSourceFile(file);
    const sourceHash = hash(source);
    if (args.sourceHash && args.sourceHash !== sourceHash) throw new IndexError('documentChanged', `Document changed; search again: ${file}`);
    const lines = source.split('\n').length - Number(source.endsWith('\n'));
    if (args.startLine > lines) throw new IndexError('lineNotFound', `Start line is past the end of the file: ${file}`);
    const endLine = Math.min(args.endLine ?? args.startLine + 19, lines);
    return { file, startLine: args.startLine, endLine, sourceHash, content: extract(source, args.startLine, endLine) };
  }
  backlinks(document: DocumentIndex, termId?: string) {
    const term = termId ? document.terms.find(t => t.localId === termId || t.id === termId) : undefined;
    if (termId && !term) throw new IndexError('termNotFound', `Term is not defined in ${document.file}: ${termId}`);
    return this.data.documents.flatMap(source => source.outgoing.filter(ref => ref.resolution?.status === 'found' && ref.resolution.file === document.file && (!term || ref.resolution.targetId === term.id)).map(reference => ({ file: source.file, ...reference })));
  }
}

function parseDocumentForConfig(source: string): Record<string, unknown> { return parseFrontmatter(source)?.values ?? {}; }
export function unresolved(reference: Reference): boolean {
  return ['missing', 'ambiguous', 'outside'].includes(reference.resolution?.status ?? 'missing') || ['missing', 'ambiguous', 'notIndexed'].includes(reference.resolution?.fragmentStatus ?? '');
}
