import * as path from 'node:path';
import { PathRules } from '../ignore-rules';

/** Shared traversal/event exclusions; symlinks are checked separately by callers. */
export function isExcludedIndexPath(root: string, absolute: string, cacheDirectory: string, rules = PathRules.none(), directory = false): boolean {
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
  if (rules.excludes(relative, directory)) return true;
  const cached = path.relative(cacheDirectory, absolute);
  return cached === '' || (cached !== '..' && !cached.startsWith(`..${path.sep}`) && !path.isAbsolute(cached));
}
