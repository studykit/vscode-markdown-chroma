import * as path from 'node:path';
import { parseDocument } from 'yaml';
import type { PreviewHost, RenderEnvironment } from './types';

export type Settings = Record<string, any>;
export function mergeSettings(base: Settings, override: Settings): Settings {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeSettings(result[key] && typeof result[key] === 'object' ? result[key] : {}, value) : value;
  }
  return result;
}

/** Optional nearest configuration, confined to the same boundary as note embeds. */
export function mystConfiguration(host: PreviewHost, env: RenderEnvironment): { project: Settings; root?: string; error?: string } {
  const source = env.currentDocument;
  if (!source || (source.scheme && source.scheme !== 'file')) return { project: {} };
  const read = (file: string, stack: string[]): Settings => {
    if (stack.includes(file) || stack.length >= 8) throw new Error('Cyclic or deeply nested MyST configuration extends.');
    const content = host.read(file);
    if (content === undefined) throw new Error('Cannot read MyST configuration.');
    const document = parseDocument(content, { uniqueKeys: true });
    if (document.errors.length) throw new Error(document.errors[0].message);
    const config = document.toJS({ maxAliasCount: 50 });
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('MyST configuration must be a YAML mapping.');
    let project: Settings = {};
    const inherited = Array.isArray(config.extends) ? config.extends : config.extends ? [config.extends] : [];
    for (const target of inherited) {
      if (typeof target !== 'string') throw new Error('MyST configuration extends must contain local filenames.');
      const resolution = host.resolve(target.startsWith('.') ? target : `./${target}`, file);
      if (resolution.status !== 'found') throw new Error('Cannot load extended MyST configuration inside the vault.');
      project = mergeSettings(project, read(resolution.path, [...stack, file]));
    }
    const own = config.project && typeof config.project === 'object' && !Array.isArray(config.project) ? { ...config.project } : {};
    if (own.bibliography) {
      const entries = Array.isArray(own.bibliography) ? own.bibliography : [own.bibliography];
      own.bibliography = entries.filter((entry: unknown) => typeof entry === 'string').map((entry: string) => {
        const relative = path.relative(path.dirname(source.fsPath), path.resolve(path.dirname(file), entry)).split(path.sep).join('/');
        return relative.startsWith('.') ? relative : `./${relative}`;
      });
    }
    return mergeSettings(project, own);
  };
  let directory = path.dirname(source.fsPath);
  for (let depth = 0; depth < 64; depth++) {
    for (const name of ['myst.yml', 'myst.yaml']) {
      const target = path.relative(path.dirname(source.fsPath), path.join(directory, name)).split(path.sep).join('/');
      const resolution = host.resolve(target.startsWith('.') ? target : `./${target}`, source.fsPath);
      if (resolution.status === 'outside') return { project: {} };
      if (resolution.status !== 'found') continue;
      try { return { project: read(resolution.path, []), root: directory }; }
      catch (error) { return { project: {}, root: directory, error: `MyST configuration: ${error instanceof Error ? error.message : error}` }; }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { project: {} };
}
