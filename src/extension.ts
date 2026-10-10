import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import { registerIndexMcpProvider } from './mcp-provider';
import type MarkdownIt from 'markdown-it';
import { extendObsidianMarkdown } from './markdown';
import { extendMystMarkdown } from './myst';
import { resolvePreviewRoot, FileVault, isWithin } from './vault';
import type { PreviewHost, RenderEnvironment } from './types';

export async function activate(context: vscode.ExtensionContext) {
  const mcpProvider = registerIndexMcpProvider(context);
  const vaults = new Map<string, FileVault>();
  const pending = new Map<string, Promise<FileVault>>();
  let disposed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let indexTimer: ReturnType<typeof setTimeout> | undefined;

  const dirtyText = (file: string) => vscode.workspace.textDocuments.find(document => document.uri.fsPath === file)?.getText();
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
  const ensure = (file: string): Promise<FileVault> => {
    const root = rootFor(file);
    const existing = pending.get(root);
    if (existing) return existing;
    const indexed = vaults.get(root);
    if (indexed) return Promise.resolve(indexed);
    const vault = new FileVault(root, dirtyText);
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
  const refresh = async () => {
    const sources = vscode.workspace.textDocuments.filter(document => document.languageId === 'markdown' && document.uri.scheme === 'file').map(document => document.uri.fsPath);
    await Promise.all(sources.map(ensure));
    await Promise.all([...vaults.values()].map(vault => vault.refresh()));
    refreshPreviews();
  };
  const host: PreviewHost = {
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
    vscode.commands.registerCommand('obsidianMarkdown.refreshVault', refresh),
    vscode.workspace.onDidOpenTextDocument(document => {
      if (document.languageId === 'markdown' && document.uri.scheme === 'file') void ensure(document.uri.fsPath);
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'markdown') {
        if (event.document.uri.scheme === 'file') forSource(event.document.uri.fsPath)?.updateAliases(event.document.uri.fsPath, event.document.getText());
        refreshPreviews();
      } else if (event.document.languageId === 'yaml') refreshPreviews();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('markdownChroma.preview')) {
        vaults.clear(); pending.clear();
        void refresh();
      }
    }),
    { dispose: () => { disposed = true; clearTimeout(refreshTimer); clearTimeout(indexTimer); } }
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const changed = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file' || uri.fsPath.split(path.sep).some(segment => ['.git', '.obsidian', 'node_modules'].includes(segment))) return;
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
