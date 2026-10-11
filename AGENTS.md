# Agent guidance for Markdown Chroma

Markdown Chroma renders Obsidian Markdown and MyST / Jupyter Book 2 in VS Code's built-in Markdown Preview. It also provides saved-file retrieval through a CLI, a shared Node API, and stdio / Streamable HTTP MCP servers.

## Common rules

- Write `README.md`, `AGENTS.md`, and developer guides in English.
- Keep the README user-facing. Start with ordinary Markdown folders and describe Obsidian Markdown rendering explicitly; an Obsidian vault is optional.
- Keep this file a concise entry point. Put subsystem implementation details in the guides below.
- Use the official, pinned MyST packages through public extension points; do not patch or fork dependencies.
- Preserve document-root, traversal, symlink, size, and cycle checks. Preview can use unsaved open documents; CLI and MCP use saved files.
- Ordinary rendering, indexing, and reads do not execute document code. Preview project plugins require workspace trust and explicit opt-in; CLI/MCP plugin expansion requires a separate launch opt-in. Workers are not permission sandboxes.
- Keep CLI and MCP on the same root-bound `IndexService`, with original source content and concise retrieval responses.
- Preserve existing `obsidianMarkdown.*` command IDs for compatibility. Documentation changes do not authorize runtime changes.

## Task-specific guidance

Read the relevant guides before changing a subsystem:

| Task | Guidance |
| --- | --- |
| Setup, build, packaging, runtime verification, or locating source files | [Development guide](docs/DEVELOPMENT.md) |
| Preview parsing, rendering, document roots, settings, or project plugins | [Preview implementation](docs/development/PREVIEW.md) and [user-facing preview guide](docs/PREVIEW.md) |
| Indexing, CLI, shared API, watching, or directive expansion | [Index/CLI/MCP implementation](docs/development/INDEX-MCP.md) and [CLI specification](docs/CLI-INDEX-SPEC.md) |
| MCP tools, transports, or VS Code providers | [Index/CLI/MCP implementation](docs/development/INDEX-MCP.md) and [MCP guide](docs/MCP.md) |

## Verification and Git

Use Node.js 20 or later. Install dependencies with `npm install`.

- Source or dependency changes: run `npm run check` (type checking, build, and Node tests).
- Preview rendering, document resolution, or VS Code provider changes: also run `npm run test:integration` with `VSCODE_EXECUTABLE_PATH` set to an installed VS Code executable. Check actual rendered content or MCP calls; a build alone is not runtime proof.
- Packaging changes: inspect the VSIX or npm archive for required bundles, styles, fonts, notices, documentation, and public declarations. Verify installation and CLI/MCP/API behavior in isolated consumer environments.
- Documentation-only changes: inspect the diff, links, examples, and Markdown structure; rebuild only if documented behavior needs verification.
- Run `git diff --check`. Stage requested paths explicitly and run `git diff --cached --check` before committing. Commit and push only when requested.
