import { parseDocument } from 'yaml';

export interface Frontmatter {
  endLine: number;
  values?: Record<string, unknown>;
  error?: string;
}

export function parseFrontmatter(source: string): Frontmatter | undefined {
  const lines = source.split('\n');
  if (lines[0]?.replace(/^\uFEFF/, '').trimEnd() !== '---') return;
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end < 0) return;
  try {
    const document = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true });
    if (document.errors.length) return { endLine: end + 1, error: document.errors[0].message };
    const values: unknown = document.toJS({ maxAliasCount: 50 });
    if (values !== null && (typeof values !== 'object' || Array.isArray(values))) {
      return { endLine: end + 1, error: 'Properties must be a YAML mapping.' };
    }
    return { endLine: end + 1, values: (values ?? {}) as Record<string, unknown> };
  } catch (error) {
    return { endLine: end + 1, error: error instanceof Error ? error.message : 'Invalid YAML.' };
  }
}

export function aliasesFrom(source: string): string[] {
  const value = parseFrontmatter(source)?.values?.aliases;
  return (Array.isArray(value) ? value : typeof value === 'string' ? [value] : [])
    .filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0);
}
