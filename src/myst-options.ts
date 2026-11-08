import { gridDirectives } from 'myst-ext-grid';
import { cardDirective } from 'myst-ext-card';
import { tabDirectives } from 'myst-ext-tabs';
import { proofDirective } from 'myst-ext-proof';
import { exerciseDirectives } from 'myst-ext-exercise';
import { buttonRole } from 'myst-ext-button';
import { defaultOptions } from 'myst-parser';
import type { DirectiveSpec } from 'myst-common';
import { termDirective, termOptionNames } from './glossary';

// Built-in extensions shared by preview, indexing, and explicit expansion.
export const previewMystOptions = {
  directives: [...gridDirectives, cardDirective, ...tabDirectives, proofDirective, ...exerciseDirectives, termDirective('term-def')],
  roles: [buttonRole], extensions: { frontmatter: false, strikethrough: true }
};

const builtInNames = new Set([...defaultOptions.directives, ...previewMystOptions.directives].flatMap(spec => [spec.name, ...(spec.alias ?? [])]));
const syntaxName = /^[a-z][a-z0-9_:-]*$/;

/** Project mappings are data only. Each names one term directive and its option spellings. */
export function configuredTermDirectives(declarations: unknown, overrides: readonly DirectiveSpec[] = []): DirectiveSpec[] {
  if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) return [];
  const taken = new Set([...builtInNames, ...overrides.flatMap(spec => [spec.name, ...(spec.alias ?? [])])]);
  const specs: DirectiveSpec[] = [];
  for (const [name, mapping] of Object.entries(declarations).slice(0, 64)) {
    if (!syntaxName.test(name) || Object.hasOwn(Object.prototype, name) || taken.has(name) || !mapping || typeof mapping !== 'object' || Array.isArray(mapping)) continue;
    const keys = { ...termOptionNames };
    for (const key of Object.keys(keys) as (keyof typeof keys)[]) {
      if (Object.hasOwn(mapping, key) && typeof mapping[key] === 'string') keys[key] = mapping[key];
    }
    const values = Object.values(keys);
    if (values.some(value => !syntaxName.test(value)) || new Set(values).size !== values.length) continue;
    specs.push(termDirective(name, keys));
  }
  return specs;
}
