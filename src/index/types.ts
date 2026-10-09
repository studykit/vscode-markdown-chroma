/** Persisted records contain structure and references, never the document body. */
export const SCHEMA_VERSION = 1;
export const PARSER_VERSION = 'myst-parser@1.7.4/chroma-index@1';
export interface Diagnostic { code: string; message: string; file?: string; line?: number; severity: 'warning' | 'error' }
export interface Range { startLine: number; endLine: number }
export interface Section extends Range {
  id: string; title: string; level: number; headingPath: string[]; labels: string[]; ownEndLine: number;
}
export interface ContentItem extends Range {
  id: string; file: string; sectionId: string | null; headingPath: string[]; labels: string[]; sourceHash: string;
}
export interface Table extends ContentItem {
  syntax: string; caption: string | null; headers: string[]; rowCount: number | null;
  headerRowCount: number | null; columnCount: number | null; contentStatus: 'inline' | 'referenceOnly';
}
export interface Image extends ContentItem {
  syntax: string; source: string; alt: string; resolution?: Resolution;
  figure: { id: string; labels: string[]; caption: string | null } | null;
}
export interface Glossary extends ContentItem { localId: string; name: string | null; termCount: number }
export interface Term extends ContentItem { localId: string; identifier: string; name: string; glossaryId: string }
export interface Target extends Range { label: string; identifier: string; kind: string; id: string | null; nodeStartLine: number; implicit?: boolean }
export interface Resolution {
  status: 'found' | 'missing' | 'ambiguous' | 'outside' | 'external' | 'citation';
  file?: string; candidates?: string[]; targetKind?: string; targetId?: string;
  fragmentStatus?: 'found' | 'missing' | 'ambiguous' | 'notIndexed';
}
export interface Reference extends Range {
  kind: 'wiki' | 'embed' | 'link' | 'doc' | 'ref' | 'term' | 'include' | 'citation';
  syntax: 'markdown' | 'myst' | 'obsidian';
  target: string; fragment: string | null; raw: string; column: number;
  sectionId: string | null; headingPath: string[]; resolution?: Resolution;
}
export interface DocumentIndex {
  file: string; sourceHash: string; signature: string; configHash: string;
  properties: Record<string, unknown>; aliases: string[]; tags: { name: string; normalized: string }[];
  sections: Section[]; tables: Table[]; images: Image[]; glossaries: Glossary[]; terms: Term[];
  targets: Target[]; outgoing: Reference[]; diagnostics: Diagnostic[]; bibliographyKeys: string[];
}
export interface ProjectIndex {
  schemaVersion: number; parserVersion: string; root: string; generation: number;
  documents: DocumentIndex[]; diagnostics: Diagnostic[];
}
export class IndexError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
export const normalizeTag = (value: string) => value.replace(/^#/, '').normalize('NFC').toLowerCase();
export const globalId = (file: string, id: string) => `${file.split('/').map(encodeURIComponent).join('/')}#${encodeURIComponent(id)}`;
