import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IndexService, QueryResult } from './query';
import { IndexError } from './types';
import { isExcludedIndexPath } from './paths';

export type IndexRefreshResult = Extract<QueryResult, { documentCount: number }>;
export interface IndexWatchOptions {
  debounceMs?: number;
  pollIntervalMs?: number;
  onRefresh?: (result: IndexRefreshResult) => void;
  onError?: (error: unknown) => void;
}

/** Event-driven refresh reuses the same serialized, hash-checked query service. */
export async function startIndexWatch(service: IndexService, options: IndexWatchOptions = {}) {
  const debounceMs = options.debounceMs ?? 300, pollIntervalMs = options.pollIntervalMs ?? 30_000;
  if (![debounceMs, pollIntervalMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647)) {
    throw new IndexError('invalidArguments', 'Watch intervals must be positive integers up to 2147483647 ms.');
  }
  const watches = new Map<string, { identity: string; handle: fs.FSWatcher }>();
  let cacheDirectory = path.dirname(service.cacheFile);
  const abort = new AbortController();
  let stopped = false, dirty = false, timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined, lastGeneration: number | undefined;
  const report = (error: unknown) => { if (!stopped) options.onError?.(error); };
  const excluded = (absolute: string) => isExcludedIndexPath(service.root, absolute, cacheDirectory);
  const schedule = () => {
    if (stopped) return;
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void refresh(); }, debounceMs);
  };
  // Individual directory watches skip excluded trees and can reattach after renames.
  const syncWatches = () => {
    // Cache paths may use a symlinked ancestor (e.g. /var on macOS).
    try { cacheDirectory = fs.realpathSync(path.dirname(service.cacheFile)); } catch { /* Created by the first refresh. */ }
    const directories = new Map<string, string>();
    const visit = (directory: string) => {
      try {
        const stat = fs.statSync(directory, { bigint: true });
        if (fs.realpathSync(directory) !== directory || !stat.isDirectory()) return;
        directories.set(directory, `${stat.dev}:${stat.ino}`);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const absolute = path.join(directory, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink() && !excluded(absolute)) visit(absolute);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(error); }
    };
    visit(service.root);
    for (const [directory, watched] of watches) {
      if (directories.get(directory) !== watched.identity) { watched.handle.close(); watches.delete(directory); }
    }
    for (const [directory, identity] of directories) {
      if (watches.has(directory)) continue;
      try {
        const handle = fs.watch(directory, (_event, filename) => {
          if (filename && excluded(path.resolve(directory, filename.toString()))) return;
          schedule();
        });
        handle.on('error', error => {
          handle.close();
          if (watches.get(directory)?.handle === handle) watches.delete(directory);
          report(error); schedule();
        });
        watches.set(directory, { identity, handle });
      } catch (error) { report(error); }
    }
  };
  const refresh = (): Promise<void> => {
    if (stopped || pending) return pending ?? Promise.resolve();
    dirty = false;
    pending = (async () => {
      try {
        syncWatches();
        const result = await service.execute({ command: 'index', arguments: {} }, { signal: abort.signal }) as IndexRefreshResult;
        if (!stopped && result.generation !== lastGeneration) {
          lastGeneration = result.generation;
          options.onRefresh?.(result);
        }
        if (!stopped) syncWatches();
      } catch (error) { report(error); }
    })().finally(() => { pending = undefined; if (dirty && !stopped) schedule(); });
    return pending;
  };
  await refresh();
  // Full hash scans cover missed OS events, unsupported watchers and replaced roots.
  const poll = setInterval(() => { dirty = true; void refresh(); }, pollIntervalMs);
  return { close: async () => {
    if (!stopped) {
      stopped = true; abort.abort(); clearInterval(poll);
      if (timer) clearTimeout(timer);
      for (const watched of watches.values()) watched.handle.close();
      watches.clear();
    }
    await pending;
  } };
}
