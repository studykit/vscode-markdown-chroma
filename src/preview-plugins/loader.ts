import { isBuiltin } from 'node:module';
import { readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let root: string;
let bridges: Record<string, string>;
export function initialize(data: { root: string; bridges: Record<string, string> }) {
  root = data.root; bridges = data.bridges;
}
const within = (file: string) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

// These hooks provide bundled MyST imports and confine module discovery. They
// are not a security sandbox: explicitly enabled, trusted code has Node access.
export async function resolve(specifier: string, context: any, nextResolve: any) {
  if (Object.hasOwn(bridges, specifier)) return { url: bridges[specifier], shortCircuit: true };
  if (isBuiltin(specifier)) return nextResolve(specifier, context);
  if (/^[a-z][a-z\d+.-]*:/i.test(specifier) && !specifier.startsWith('file:')) throw new Error('Only local project modules are supported.');
  const result = await nextResolve(specifier, context);
  if (!result.url.startsWith('file:')) throw new Error('Only local project modules are supported.');
  const file = await realpath(fileURLToPath(result.url));
  if (!within(file) || path.relative(root, file).split(path.sep).some(part => part === '.git' || part === '.obsidian')) throw new Error('Plugin import is outside the preview root or in an excluded directory.');
  return result;
}

export async function load(url: string, context: any, nextLoad: any) {
  if (url.startsWith('file:')) {
    const file = await realpath(fileURLToPath(url));
    if (!within(file)) throw new Error('Plugin module is outside the preview root.');
    if (!file.split(path.sep).includes('node_modules') && /\.(?:mjs|js)$/.test(file)) {
      const before = await stat(file);
      if (before.size > 2 * 1024 * 1024) throw new Error('Local plugin module exceeds the 2 MiB limit.');
      const bytes = await readFile(file);
      const after = await stat(file);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.ino !== after.ino) throw new Error('Plugin module changed while loading; save and retry.');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { format: 'module', source, shortCircuit: true };
    }
  }
  return nextLoad(url, context);
}
