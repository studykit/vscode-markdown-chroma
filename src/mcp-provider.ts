import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isWithin } from './vault';

export const MCP_PROVIDER_ID = 'markdownChroma.index';

/** VS Code starts/stops these processes; the extension only supplies definitions. */
export function registerIndexMcpProvider(context: vscode.ExtensionContext): vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> | undefined {
  // Retain preview support on older hosts that do not expose the stable MCP API.
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') return;
  const changed = new vscode.EventEmitter<void>();
  const output = vscode.window.createOutputChannel('Markdown Chroma MCP');
  const definitions = () => {
    if (!vscode.workspace.isTrusted) return [];
    const servers: vscode.McpStdioServerDefinition[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      const config = vscode.workspace.getConfiguration('markdownChroma.mcp', folder.uri);
      if (!config.get<boolean>('enabled', true)) continue;
      try {
        const workspaceRoot = fs.realpathSync(folder.uri.fsPath);
        const configured = config.get<string>('root', '');
        const root = fs.realpathSync(path.resolve(workspaceRoot, configured));
        if (!isWithin(workspaceRoot, root) || !fs.statSync(root).isDirectory()) throw new Error('MCP root must be a directory inside this workspace folder.');
        const server = new vscode.McpStdioServerDefinition(`Markdown Chroma: ${folder.name}`,
          process.execPath, [context.asAbsolutePath('dist/mcp.cjs'), '--root', root, ...(config.get<boolean>('projectPlugins', false) ? ['--allow-project-plugins'] : [])],
          { ELECTRON_RUN_AS_NODE: '1' }, context.extension.packageJSON.version);
        server.cwd = vscode.Uri.file(root);
        servers.push(server);
      } catch (error) { output.appendLine(`${folder.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return servers;
  };
  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: token => token.isCancellationRequested ? [] : definitions(),
    resolveMcpServerDefinition: (server, token) => token.isCancellationRequested ? undefined : definitions().find(current =>
      current.label === server.label && current.command === server.command && JSON.stringify(current.args) === JSON.stringify(server.args)),
  };
  context.subscriptions.push(changed, output,
    vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider),
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => changed.fire()),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('markdownChroma.mcp')) changed.fire(); }),
  );
  return provider;
}
