export interface PreviewSettings {
  maxEmbedDepth: number;
}

export interface DocumentUri {
  fsPath: string;
  scheme?: string;
}

export interface RenderEnvironment {
  currentDocument?: DocumentUri;
  previewDocument?: DocumentUri;
  resourceProvider?: { asWebviewUri(uri: unknown): { toString(): string } };
  containingImages?: Set<string>;
  slugifier?: { add(title: string): { value: string } };
  docId?: string;
  obsidian?: RenderContext;
  [key: string]: unknown;
}

export interface RenderContext {
  stack: string[];
  budget: { count: number; bytes: number };
  prefix: string;
}

export type Resolution =
  | { status: 'found'; path: string }
  | { status: 'missing' | 'ambiguous' | 'outside'; candidates?: string[] };

export interface PreviewHost {
  resolve(target: string, source?: string): Resolution;
  read(file: string): string | undefined;
  documentUri(file: string): DocumentUri;
  resourceUri(file: string, env: RenderEnvironment): string;
  settings(env: RenderEnvironment): PreviewSettings;
}

export interface WikiReference {
  target: string;
  fragment: string;
  label?: string;
  raw: string;
}
