import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PdfDocumentOptions {
  /** HTML produced by VS Code's `markdown.api.render` for the source document. */
  body: string;
  title: string;
  /** Source document path; relative links and images resolve from its folder. */
  source: string;
  /** Local stylesheets in cascade order. */
  styles: string[];
  /** Local preview script that renders client-side content such as Mermaid. */
  script: string;
  nonce: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
// Settings land in a style attribute; drop characters that could end the declaration.
const cssValue = (value: string) => value.replace(/[;{}<>\\]/g, '').trim();
const fileUrl = (file: string) => pathToFileURL(file).href;

/**
 * A standalone page for headless printing. The policy mirrors the built-in
 * preview: scripts in the document never run; only the nonce-bearing preview
 * script does. Remote images and fonts stay available as in the preview.
 */
export function buildPdfHtml(options: PdfDocumentOptions): string {
  const csp = [
    "default-src 'none'",
    'img-src file: https: data:',
    'media-src file: https: data:',
    "style-src file: https: 'unsafe-inline'",
    'font-src file: https: data:',
    `script-src 'nonce-${options.nonce}'`
  ].join('; ');
  const variables = [
    options.fontFamily && cssValue(options.fontFamily) ? `--markdown-font-family: ${cssValue(options.fontFamily)};` : '',
    options.fontSize && options.fontSize > 0 ? `--markdown-font-size: ${options.fontSize}px;` : '',
    options.lineHeight && options.lineHeight > 0 ? `--markdown-line-height: ${options.lineHeight};` : ''
  ].join(' ').trim();
  const base = fileUrl(path.dirname(options.source) + path.sep);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<base href="${escapeHtml(base)}">
<title>${escapeHtml(options.title)}</title>
${options.styles.map(style => `<link rel="stylesheet" href="${escapeHtml(fileUrl(style))}">`).join('\n')}
</head>
<body class="vscode-body vscode-light markdown-chroma-pdf"${variables ? ` style="${escapeHtml(variables)}"` : ''}>
${options.body}
<script nonce="${escapeHtml(options.nonce)}" src="${escapeHtml(fileUrl(options.script))}"></script>
</body>
</html>
`;
}

export interface BrowserLookup {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists(file: string): boolean;
}

/** Installed Chromium-based browsers in preference order. */
export function browserCandidates({ platform, env }: Omit<BrowserLookup, 'exists'>): string[] {
  if (platform === 'darwin') {
    const apps = [
      ['Google Chrome', 'Google Chrome'], ['Microsoft Edge', 'Microsoft Edge'],
      ['Chromium', 'Chromium'], ['Brave Browser', 'Brave Browser']
    ];
    const roots = ['/Applications', ...(env.HOME ? [path.posix.join(env.HOME, 'Applications')] : [])];
    return roots.flatMap(root => apps.map(([app, binary]) => path.posix.join(root, `${app}.app`, 'Contents', 'MacOS', binary)));
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((root): root is string => !!root);
    const binaries = [
      'Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    ];
    return binaries.flatMap(binary => roots.map(root => path.win32.join(root, binary)));
  }
  const names = ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable', 'chromium', 'chromium-browser', 'brave-browser'];
  const directories = (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(path.posix.delimiter).filter(Boolean);
  return [...names.flatMap(name => directories.map(directory => path.posix.join(directory, name))), '/snap/bin/chromium'];
}

/** The configured browser when set, otherwise the first installed candidate. */
export function findBrowser(configured: string | undefined, lookup: BrowserLookup): string | undefined {
  const explicit = configured?.trim();
  if (explicit) return lookup.exists(explicit) ? explicit : undefined;
  return browserCandidates(lookup).find(candidate => lookup.exists(candidate));
}

/** Default PDF path next to the source document. */
export function pdfPathFor(source: string): string {
  const parsed = path.parse(source);
  return path.join(parsed.dir, `${parsed.name}.pdf`);
}
