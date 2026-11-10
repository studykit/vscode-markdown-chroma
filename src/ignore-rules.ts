import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';

/** Root-level exclusion file shared by preview, CLI, and MCP. It uses `.gitignore` syntax. */
export const IGNORE_FILE = '.chromaignore';
export const MAX_IGNORE_FILE_BYTES = 256 * 1024;

const builtIn = (part: string) => part.startsWith('.') || part === 'node_modules' || part === '_build';

/** Built-in exclusions plus optional `.chromaignore` patterns, matched on root-relative paths. */
export class PathRules {
  private constructor(private readonly rules?: Ignore, readonly error?: string) {}

  static none(): PathRules { return new PathRules(); }

  static parse(source: string | undefined, error?: string): PathRules {
    if (error || source === undefined || !source.trim()) return new PathRules(undefined, error);
    try { return new PathRules(ignore({ allowRelativePaths: false }).add(source)); }
    catch (error) { return new PathRules(undefined, `${IGNORE_FILE} — ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * `relative` is a root-relative path with either separator. `directory` lets
   * directory-only patterns such as `build/` match the directory itself; files
   * below an excluded directory are always excluded, as in Git.
   */
  excludes(relative: string, directory = false): boolean {
    const parts = relative.split(/[\\/]/).filter(Boolean);
    if (!parts.length) return false;
    if (parts.some(builtIn)) return true;
    if (!this.rules) return false;
    const portable = parts.join('/');
    try { return this.rules.ignores(directory ? `${portable}/` : portable); }
    catch { return false; }
  }
}

/** Reads `<root>/.chromaignore` as a regular, non-symlink file within the size limit. */
export function readIgnoreFile(root: string): { source?: string; error?: string } {
  const file = path.join(root, IGNORE_FILE);
  let handle: number | undefined;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) return { error: `${IGNORE_FILE} — Not a regular file.` };
    if (stat.size > MAX_IGNORE_FILE_BYTES) return { error: `${IGNORE_FILE} — File exceeds the 256 KiB limit.` };
    return { source: fs.readFileSync(handle, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return {};
    return { error: `${IGNORE_FILE} — ${code === 'ELOOP' ? 'Symlinks are not followed.' : `Cannot read: ${code ?? String(error)}`}` };
  } finally { if (handle !== undefined) fs.closeSync(handle); }
}

export function loadPathRules(root: string): PathRules {
  const { source, error } = readIgnoreFile(root);
  return PathRules.parse(source, error);
}
