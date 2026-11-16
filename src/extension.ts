import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import { registerIndexMcpProvider } from './mcp-provider';
import type MarkdownIt from 'markdown-it';
import { extendObsidianMarkdown } from './markdown';
import { extendMystMarkdown } from './myst';
import { resolvePreviewRoot, FileVault, isWithin } from './vault';
import { PreviewPluginManager } from './preview-plugins/manager';
import { PreviewPluginDiagnostics } from './preview-plugins/diagnostics';
import { pluginRecovery } from './preview-plugins/events';
import type { PreviewHost, RenderEnvironment } from './types';
import { buildPdfHtml, findBrowser, pdfPathFor } from './pdf/document';
import type { printPdf } from './pdf/printer';

export async function activate(context: vscode.ExtensionContext) {
  const mcpProvider = registerIndexMcpProvider(context);
  const vaults = new Map<string, FileVault>();
  const pending = new Map<string, Promise<FileVault>>();
  let disposed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let indexTimer: ReturnType<typeof setTimeout> | undefined;

  const dirtyText = (file: string) => vscode.workspace.textDocuments.find(document => document.uri.fsPath === file)?.getText();
  const openFiles = () => vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file').map(document => document.uri.fsPath);
  const rootFor = (file: string) => {
    const uri = vscode.Uri.file(file);
    const workspace = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const configured = vscode.workspace.getConfiguration('markdownChroma.preview', uri).get<string>('root', '');
    return resolvePreviewRoot(file, workspace, configured);
  };
  const refreshPreviews = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (!disposed) void vscode.commands.executeCommand('markdown.preview.refresh');
    }, 150);
  };
  const pluginOutput = vscode.window.createOutputChannel('Markdown Chroma: MyST Plugins');
  const pluginProblems = vscode.languages.createDiagnosticCollection('markdownChroma.projectPlugins');
  const pluginDiagnostics = new PreviewPluginDiagnostics(pluginOutput, items => {
    const entries = new Map<string, vscode.Diagnostic[]>();
    for (const item of items) {
      const line = item.line! - 1, column = item.column! - 1;
      const diagnostic = new vscode.Diagnostic(new vscode.Range(line, column, line, column + 1), `${item.reason}\n${pluginRecovery}`,
        item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
      diagnostic.source = 'Markdown Chroma: MyST Plugins'; diagnostic.code = item.phase;
      const file = item.file!;
      if (!entries.has(file)) entries.set(file, []);
      entries.get(file)!.push(diagnostic);
    }
    pluginProblems.clear();
    pluginProblems.set([...entries].map(([file, diagnostics]) => [vscode.Uri.file(file), diagnostics]));
  });
  const plugins = new PreviewPluginManager(refreshPreviews, undefined, undefined, event => pluginDiagnostics.accept(event));
  context.subscriptions.push({ dispose() { plugins.dispose(); pluginDiagnostics.dispose(); pluginProblems.dispose(); pluginOutput.dispose(); } });
  const ensure = (file: string): Promise<FileVault> => {
    const root = rootFor(file);
    const existing = pending.get(root);
    if (existing) return existing;
    const indexed = vaults.get(root);
    if (indexed) return Promise.resolve(indexed);
    const vault = new FileVault(root, dirtyText, openFiles);
    vaults.set(root, vault);
    const ready = vault.refresh().then(() => {
      pending.delete(root);
      refreshPreviews();
      return vault;
    });
    pending.set(root, ready);
    return ready;
  };
  const forSource = (file?: string) => {
    if (!file) return;
    const root = rootFor(file);
    const vault = vaults.get(root);
    if (!vault) void ensure(file);
    return vault;
  };
  const refresh = async (reloadPlugins = false) => {
    if (reloadPlugins) plugins.invalidate();
    const sources = vscode.workspace.textDocuments.filter(document => document.languageId === 'markdown' && document.uri.scheme === 'file').map(document => document.uri.fsPath);
    await Promise.all(sources.map(ensure));
    await Promise.all([...vaults.values()].map(vault => vault.refresh()));
    refreshPreviews();
  };
  const host: PreviewHost = {
    language: vscode.env.language,
    folderGlossaryHeading: file => forSource(file)?.folderGlossaryHeading(file),
    referenceFiles: (identifier, source) => forSource(source)?.referenceFiles(identifier, source) ?? [],
    markdownFiles: source => forSource(source)?.markdownFiles(source) ?? [],
    parseMystPlugins: (source, file, project) => plugins.parse(source, file, rootFor(file), project,
      vscode.workspace.getConfiguration('markdownChroma.preview', vscode.Uri.file(file)).get<boolean>('projectPlugins', false),
      vscode.workspace.isTrusted && !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))),
    resolve: (target, source) => forSource(source)?.resolve(target, source) ?? { status: 'missing' },
    read: file => {
      const vault = [...vaults.values()].filter(candidate => isWithin(candidate.root, file)).sort((a, b) => b.root.length - a.root.length)[0];
      return vault?.read(file);
    },
    documentUri: file => vscode.Uri.file(file),
    resourceUri: (file, env) => env.resourceProvider
      ? env.resourceProvider.asWebviewUri(vscode.Uri.file(file)).toString()
      : pathToFileURL(file).href,
    settings: (env: RenderEnvironment) => {
      const configuration = vscode.workspace.getConfiguration('markdownChroma.preview', env.currentDocument as vscode.Uri | undefined);
      return {
        maxEmbedDepth: Math.min(20, Math.max(1, configuration.get<number>('maxEmbedDepth', 5)))
      };
    }
  };

  const pdfSource = async (uri?: unknown): Promise<vscode.TextDocument | undefined> => {
    if (uri instanceof vscode.Uri) return vscode.workspace.openTextDocument(uri);
    const active = vscode.window.activeTextEditor?.document;
    if (active?.languageId === 'markdown') return active;
    // A focused preview has no text editor; prefer the visible source beside it.
    const visible = [...new Set(vscode.window.visibleTextEditors.map(editor => editor.document).filter(document => document.languageId === 'markdown'))];
    if (visible.length === 1) return visible[0];
    const open = vscode.workspace.textDocuments.filter(document => document.languageId === 'markdown' && document.uri.scheme === 'file');
    if (open.length === 1) return open[0];
    if (!open.length) return;
    const picked = await vscode.window.showQuickPick(open.map(document => ({ label: path.basename(document.uri.fsPath), description: vscode.workspace.asRelativePath(document.uri), document })),
      { placeHolder: 'Select the Markdown document to export as PDF' });
    return picked?.document;
  };
  const renderForPdf = async (document: vscode.TextDocument, cancel: vscode.CancellationToken) => {
    let html = await vscode.commands.executeCommand<string>('markdown.api.render', document);
    // Project plugins parse in a worker; the first render may only announce loading.
    for (let attempt = 0; attempt < 40 && html.includes('Loading MyST project plugins') && !cancel.isCancellationRequested; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      html = await vscode.commands.executeCommand<string>('markdown.api.render', document);
    }
    return html;
  };
  // `output` lets automation skip the save dialog; the command then resolves to the written path.
  const exportPdf = async (uri?: unknown, output?: unknown): Promise<string | undefined> => {
    const document = await pdfSource(uri);
    if (!document || document.languageId !== 'markdown' || document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Open a Markdown file to export it as PDF.');
      return;
    }
    const configuration = vscode.workspace.getConfiguration('markdownChroma.pdf', document.uri);
    const browser = findBrowser(configuration.get<string>('browserPath', ''), { platform: process.platform, env: process.env, exists: file => fs.existsSync(file) });
    if (!browser) {
      const configured = configuration.get<string>('browserPath', '').trim();
      void vscode.window.showErrorMessage(configured
        ? `The browser configured in markdownChroma.pdf.browserPath does not exist: ${configured}`
        : 'PDF export needs Google Chrome, Microsoft Edge, Chromium, or Brave. Install one or set markdownChroma.pdf.browserPath.', 'Open Settings')
        .then(choice => { if (choice) void vscode.commands.executeCommand('workbench.action.openSettings', 'markdownChroma.pdf.browserPath'); });
      return;
    }
    const target = output instanceof vscode.Uri ? output : await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(pdfPathFor(document.uri.fsPath)), filters: { PDF: ['pdf'] }, saveLabel: 'Export PDF' });
    if (!target) return;
    const markdownExtension = vscode.extensions.getExtension('vscode.markdown-language-features')?.extensionPath;
    const preview = vscode.workspace.getConfiguration('markdown.preview', document.uri);
    const exported = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting ${path.basename(document.uri.fsPath)} to PDF`, cancellable: true }, async (_progress, cancel) => {
      const directory = await fs.promises.mkdtemp(path.join(tmpdir(), 'markdown-chroma-pdf-'));
      try {
        await ensure(document.uri.fsPath);
        const body = await renderForPdf(document, cancel);
        if (cancel.isCancellationRequested) return false;
        const html = path.join(directory, 'document.html');
        await fs.promises.writeFile(html, buildPdfHtml({
          body, title: path.parse(document.uri.fsPath).name, source: document.uri.fsPath, nonce: randomBytes(16).toString('hex'),
          styles: [
            ...(markdownExtension ? ['markdown.css', 'highlight.css'].map(name => path.join(markdownExtension, 'media', name)) : []),
            path.join(context.extensionPath, 'media', 'preview.css'),
            path.join(context.extensionPath, 'dist', 'katex', 'katex.min.css'),
            path.join(context.extensionPath, 'media', 'pdf.css')
          ],
          script: path.join(context.extensionPath, 'dist', 'preview.js'),
          fontFamily: preview.get<string>('fontFamily'), fontSize: preview.get<number>('fontSize'), lineHeight: preview.get<number>('lineHeight')
        }));
        // Loaded on demand so activation does not pay for the browser driver.
        const printer: { printPdf: typeof printPdf } = require(path.join(context.extensionPath, 'dist', 'pdf-printer.cjs'));
        await printer.printPdf({ executablePath: browser, html, output: target.fsPath, format: configuration.get<'A4' | 'Letter'>('pageSize', 'A4') === 'Letter' ? 'Letter' : 'A4' });
        return !cancel.isCancellationRequested;
      } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    }).then(done => done, (error: unknown) => {
      if (output instanceof vscode.Uri) throw error;
      void vscode.window.showErrorMessage(`PDF export failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
    if (!exported) return;
    if (!(output instanceof vscode.Uri)) void vscode.window.showInformationMessage(`Exported ${path.basename(target.fsPath)}.`, 'Open PDF')
      .then(choice => { if (choice) void vscode.env.openExternal(target); });
    return target.fsPath;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('obsidianMarkdown.showPreview', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document || document.languageId !== 'markdown') {
        void vscode.window.showInformationMessage('Open a Markdown note to preview it.');
        return;
      }
      if (document.uri.scheme === 'file') await ensure(document.uri.fsPath);
      await vscode.commands.executeCommand('markdown.showPreviewToSide', document.uri);
    }),
    vscode.commands.registerCommand('markdownChroma.exportPdf', (uri?: unknown, output?: unknown) => exportPdf(uri, output)),
    vscode.commands.registerCommand('obsidianMarkdown.refreshVault', () => refresh(true)),
    vscode.commands.registerCommand('markdownChroma.showProjectPluginLogs', () => { pluginDiagnostics.flush(); pluginOutput.show(true); }),
    vscode.commands.registerCommand('markdownChroma.reloadProjectPlugins', async (uri?: vscode.Uri) => {
      const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
      if (!document || document.languageId !== 'markdown' || document.uri.scheme !== 'file') {
        void vscode.window.showInformationMessage('Open the Markdown source document to reload its project plugins.'); return;
      }
      if (!plugins.reloadDocument(document.uri.fsPath)) {
        void vscode.window.showInformationMessage('Open this document in Markdown Preview to load its project plugins.'); return;
      }
      refreshPreviews();
    }),
    vscode.workspace.onDidOpenTextDocument(document => {
      if (document.languageId === 'markdown' && document.uri.scheme === 'file') void ensure(document.uri.fsPath);
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'markdown') {
        if (event.document.uri.scheme === 'file') forSource(event.document.uri.fsPath)?.updateAliases(event.document.uri.fsPath, event.document.getText());
        refreshPreviews();
      } else if (event.document.languageId === 'yaml') refreshPreviews();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { plugins.invalidate(); void refresh(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { plugins.invalidate(); refreshPreviews(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('markdownChroma.preview')) {
        plugins.invalidate();
        vaults.clear(); pending.clear();
        void refresh();
      }
    }),
    { dispose: () => { disposed = true; clearTimeout(refreshTimer); clearTimeout(indexTimer); } }
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const changed = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file' || uri.fsPath.split(path.sep).some(segment => ['.git', '.obsidian'].includes(segment))) return;
    // Execute saved plugin modules only. Reload their entire dependency graph.
    if (!/\.(?:md|markdown|mdown|mkd)$/i.test(uri.fsPath)) plugins.scheduleInvalidate(uri.fsPath);
    if (uri.fsPath.split(path.sep).includes('node_modules')) { refreshPreviews(); return; }
    // Build output, agent state and `.chromaignore` patterns are outside document
    // lookup; writes there must not re-index the root or re-render previews.
    const containing = [...vaults.values()].filter(vault => isWithin(vault.root, uri.fsPath));
    if (containing.length && containing.every(vault => vault.excludes(uri.fsPath))) return;
    for (const vault of containing) vault.invalidate(uri.fsPath);
    clearTimeout(indexTimer);
    indexTimer = setTimeout(() => { if (!disposed) void refresh(); }, 300);
  };
  context.subscriptions.push(watcher, watcher.onDidCreate(changed), watcher.onDidDelete(changed), watcher.onDidChange(changed));

  await Promise.all([
    ...(vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => ensure(path.join(folder.uri.fsPath, '__obsidian_index__.md'))),
    ...vscode.workspace.textDocuments.filter(document => document.languageId === 'markdown' && document.uri.scheme === 'file').map(document => ensure(document.uri.fsPath))
  ]);
  return { extendMarkdownIt: (md: MarkdownIt) => extendMystMarkdown(extendObsidianMarkdown(md, host), host), refresh, mcpProvider };
}
