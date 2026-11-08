import { posix } from 'node:path';
import { Minimatch } from 'minimatch';
import { toText, type GenericNode } from 'myst-common';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { Frontmatter } from './frontmatter';
import { glossaryIdentifier } from './glossary';

export const FOLDER_GLOSSARY_CONFIG = 'chroma.index.yml';

const ruleSchema = z.strictObject({
  include: z.string().min(1).max(512).refine(value => !/^[\/!]|[\u0000-\u001f\\:]|(?:^|\/)\.\.(?:\/|$)/.test(value), 'Expected a root-relative glob.'),
  definitionHeading: z.string().trim().min(1).max(256),
});
const configSchema = z.strictObject({ version: z.literal(1), glossaries: z.array(ruleSchema).max(64) });
type Rule = { matcher: Minimatch; definitionHeading: string };
export type FolderGlossaryConfig = { rules: Rule[]; error?: string };
export type FolderGlossaryMatch = { heading?: string; error?: string };

export function parseFolderGlossaryConfig(source: string | undefined): FolderGlossaryConfig {
  if (source === undefined) return { rules: [] };
  try {
    const yaml = parseDocument(source, { uniqueKeys: true });
    if (yaml.errors.length) throw new Error(yaml.errors[0].message);
    const config = configSchema.parse(yaml.toJS({ maxAliasCount: 50 }));
    return { rules: config.glossaries.map(({ include, definitionHeading }) => ({
      matcher: new Minimatch(include.replace(/^\.\//, ''), { platform: 'linux', nonegate: true, nocomment: true, nobrace: true, noext: true }),
      definitionHeading,
    })) };
  } catch (error) {
    const reason = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join(', ')
      : error instanceof Error ? error.message : String(error);
    return { rules: [], error: `${FOLDER_GLOSSARY_CONFIG} — ${reason}` };
  }
}

export function matchFolderGlossary(config: FolderGlossaryConfig, file: string): FolderGlossaryMatch {
  const titles = new Set(config.rules.filter(rule => rule.matcher.match(file)).map(rule => rule.definitionHeading));
  if (titles.size > 1) return { error: 'Matching glossary rules name different definition headings.' };
  return { heading: titles.values().next().value };
}

/** MyST document blocks can contain section headings. Quotes and directives have their own scope. */
export function* documentNodes<T extends GenericNode>(tree: T): Generator<T> {
  for (const child of tree.children ?? []) {
    yield child as T;
    if (child.type === 'block') yield* documentNodes(child as T);
  }
}

export interface FolderTerm {
  name: string;
  identifier: string;
  aliases: string[];
  reviewed?: boolean;
  headingLine: number;
}

export function findFolderTerm(tree: GenericNode, file: string, heading: string, frontmatter?: Frontmatter): { term?: FolderTerm; error?: string } {
  const matches = [...documentNodes(tree)].filter(node => node.type === 'heading' && node.depth === 2 && toText(node).trim() === heading);
  const line = matches[0]?.position?.start.line;
  if (matches.length !== 1 || !line) return { error: `Expected exactly one level-two “${heading}” definition heading.` };
  const name = posix.basename(file, posix.extname(file));
  const identifier = glossaryIdentifier(name);
  const values = frontmatter?.values;
  const rawAliases = typeof values?.aliases === 'string' ? [values.aliases] : Array.isArray(values?.aliases) ? values.aliases : [];
  const seen = new Set([identifier, 'term-']);
  const aliases: string[] = [];
  for (const value of rawAliases) {
    if (typeof value !== 'string') continue;
    const alias = value.trim(), id = glossaryIdentifier(alias);
    if (!seen.has(id)) { seen.add(id); aliases.push(alias); }
  }
  const reviewed = values?.reviewed;
  const invalidReview = reviewed !== undefined && typeof reviewed !== 'boolean';
  return {
    term: { name, identifier, aliases, headingLine: line, reviewed: frontmatter?.error || invalidReview ? undefined : reviewed !== false },
    ...(invalidReview ? { error: 'Glossary frontmatter reviewed must be a boolean.' } : {}),
  };
}

export function attachFolderTerm(tree: GenericNode, term: FolderTerm): void {
  const heading = [...documentNodes(tree)].find(node => node.type === 'heading' && node.position?.start.line === term.headingLine);
  if (!heading?.identifier) return;
  heading.folderTerm = term;
  const shadow = (node: GenericNode) => {
    if (node.type === 'definitionTerm' && node.identifier === term.identifier) node.shadowedFolderTerm = true;
    node.children?.forEach(shadow);
  };
  shadow(tree);
}
