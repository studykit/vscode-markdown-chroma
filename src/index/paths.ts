import * as path from 'node:path';

/** Shared traversal/event exclusions; symlinks are checked separately by callers. */
export function isExcludedIndexPath(root: string, absolute: string, cacheDirectory: string): boolean {
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
  if (relative.split(path.sep).some(part => part.startsWith('.') || part === 'node_modules' || part === '_build')) return true;
  const cached = path.relative(cacheDirectory, absolute);
  return cached === '' || (cached !== '..' && !cached.startsWith(`..${path.sep}`) && !path.isAbsolute(cached));
}
