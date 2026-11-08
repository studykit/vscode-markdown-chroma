import { runTests } from '@vscode/test-electron';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const data = await mkdtemp(path.join(tmpdir(), 'markdown-chroma-vscode-'));
const executable = process.env.VSCODE_EXECUTABLE_PATH;
if (!executable) throw new Error('Set VSCODE_EXECUTABLE_PATH to an installed VS Code executable. This test does not download VS Code.');
const workspace = path.join(data, 'preview.code-workspace');
const glossary = path.join(data, 'folder-glossary');
await mkdir(path.join(glossary, 'Glossary'), { recursive: true });
await writeFile(path.join(glossary, 'chroma.index.yml'), 'version: 1\nglossaries:\n  - include: "Glossary/*.md"\n    definitionHeading: Definition\n');
await writeFile(path.join(glossary, 'Glossary/chat.md'), '---\naliases: [채팅방]\nreviewed: false\n---\n\n# Chat\n\n## Definition\n\nA chat room.\n');
await writeFile(path.join(glossary, 'Reference.md'), '{term}`채팅방`\n');
await writeFile(workspace, JSON.stringify({ folders: [{ path: path.resolve('examples/vault') }, { path: path.resolve('examples/myst') }, { path: glossary }] }));
await runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: [path.resolve('.'), ...(process.env.VSCODE_COMPAT_EXTENSION_PATH ? [process.env.VSCODE_COMPAT_EXTENSION_PATH] : [])],
  extensionTestsPath: path.resolve('dist/integration.cjs'),
  launchArgs: [workspace, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--user-data-dir', data, '--extensions-dir', path.join(data, 'extensions')]
});
