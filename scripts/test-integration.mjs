import { runTests } from '@vscode/test-electron';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const data = await mkdtemp(path.join(tmpdir(), 'obsidian-markdown-vscode-'));
const executable = process.env.VSCODE_EXECUTABLE_PATH;
if (!executable) throw new Error('Set VSCODE_EXECUTABLE_PATH to an installed VS Code executable. This test does not download VS Code.');
await runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: [path.resolve('.'), ...(process.env.VSCODE_COMPAT_EXTENSION_PATH ? [process.env.VSCODE_COMPAT_EXTENSION_PATH] : [])],
  extensionTestsPath: path.resolve('dist/integration.cjs'),
  launchArgs: [path.resolve('examples/vault'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--user-data-dir', data, '--extensions-dir', path.join(data, 'extensions')]
});
