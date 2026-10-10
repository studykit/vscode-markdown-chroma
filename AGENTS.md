# Agent guidance for Markdown Chroma

## Purpose and documentation

Markdown Chroma renders Obsidian Flavored Markdown and MyST / Jupyter Book 2 syntax in VS Code's built-in Markdown Preview. It also provides a saved-file index through a CLI, a shared Node API, and stdio / Streamable HTTP MCP servers.

- Write `README.md` and `AGENTS.md` in English.
- Keep the README focused on user-facing features, syntax, settings, and usage. Present ordinary Markdown folders as the starting point. Describe Obsidian Markdown rendering explicitly; an Obsidian vault is not a setup requirement.
- Keep developer setup, build commands, verification procedures, and implementation guidance in this file.
- Consult [the CLI specification](docs/CLI-INDEX-SPEC.md) for indexing and retrieval behavior and [the MCP guide](docs/MCP.md) for tool contracts and shared API usage.

## Setup and build

Use Node.js 20 or later. Install dependencies and run the standard checks:

```sh
npm install
npm run check
```

`npm run check` runs TypeScript checking, builds the project, and executes the Node test suite. `npm run build` creates the bundles and public API declarations. `npm run watch` rebuilds bundles during development.

Build and package a VS Code extension:

```sh
npm run package
```

The current manifest produces `artifacts/markdown-chroma-0.1.0.vsix`. Install it with VS Code's `Extensions: Install from VSIX...` command. Keep artifact names and documentation aligned with `package.json` when changing the version.

For CLI development, run a built entry point directly:

```sh
npm run build
node dist/cli.cjs --help
node dist/mcp.cjs --root ./examples/myst
node dist/mcp.cjs --transport http --root ./examples/myst --port 3000
node dist/cli.cjs watch --root ./examples/myst
```

To create and install the npm archive:

```sh
npm pack
npm install -g ./markdown-chroma-0.1.0.tgz
```

`npm pack` invokes the build through `prepack`. Generated bundles, archives, and VSIX files are ignored by Git.

## Runtime verification

Press F5 to launch the Extension Development Host. The launch configuration opens `examples/vault`; this is a fixture directory name, not a requirement to use an Obsidian vault. Open `Showcase.md` in the built-in Markdown Preview to inspect Obsidian syntax, local media, and embeds. MyST examples are in `examples/myst`.

Run integration tests against an installed VS Code executable:

```sh
VSCODE_EXECUTABLE_PATH='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm run test:integration
```

Set the path for the local installation. The test runner does not download VS Code. It creates an isolated user-data directory and opens both example folders. The current integration suite requires a host exposing the MCP provider API.

Choose verification according to the change:

- For source or dependency changes, run `npm run check`.
- For preview rendering, document resolution, or VS Code provider changes, also run `npm run test:integration`. Check actual rendered content or MCP calls, rather than treating a successful build as runtime proof.
- For packaging changes, inspect the resulting VSIX or npm archive for the bundles, styles, fonts, notices, documentation, and public type declarations required by that package.
- For documentation-only changes, inspect the diff, local links, examples, and Markdown structure. A code rebuild is unnecessary unless the documented behavior needs verification.
- Run `git diff --check` before handing off changes. When committing, stage the requested paths explicitly and check the staged diff. Push only when requested.

## Source map

| Area | Files |
| --- | --- |
| VS Code activation, document context, file watching, and preview refresh | `src/extension.ts` |
| Obsidian Markdown parsing and rendering | `src/markdown.ts`, `src/footnotes.ts`, `src/frontmatter.ts`, `src/callout-icons.ts` |
| Preview document lookup, aliases, and file access | `src/vault.ts` |
| MyST rendering, references, and optional configuration | `src/myst.ts`, `src/references.ts`, `src/myst-config.ts` |
| Preview styles, folding, icons, and tabs | `media/preview.css`, `media/preview.js` |
| Persistent indexing, parsing, records, shared queries, and file watching | `src/index/project.ts`, `src/index/parser.ts`, `src/index/types.ts`, `src/index/query.ts`, `src/index/paths.ts`, `src/index/watch.ts`, `src/index/watch-cli.ts` |
| CLI entry point and argument handling | `src/cli.ts`, `src/index/cli.ts` |
| Public Node API exports | `src/index/index.ts` |
| MCP entry point, transport selection, stdio / HTTP lifecycle, and tools | `src/mcp.ts`, `src/mcp/cli.ts`, `src/mcp/stdio.ts`, `src/mcp/http.ts`, `src/mcp/server.ts` |
| VS Code MCP server definitions | `src/mcp-provider.ts` |
| Bundles, assets, notices, and API declarations | `scripts/build.mjs`, `tsconfig.api.json` |
| Unit and host integration tests | `test/`, `scripts/test-integration.mjs` |

## Implementation constraints

### Preview

- Extend the built-in Markdown Preview through `extendMarkdownIt`; preserve native themes, navigation, scroll synchronization, frontmatter rendering, and ordinary code blocks.
- Parsing rules create tokens without reading files. Resolve links and embeds at render time using the current document URI supplied by VS Code. Preserve source context across cached tokens, multiple open previews, and nested embeds.
- Reflect unsaved contents of open documents in preview embeds. CLI and MCP reads use saved files instead.
- Bundle the official `myst-parser`, `myst-transforms`, and directive extensions. Use public extension points and project wrappers; do not patch or fork MyST dependencies. The current parser version is pinned in `package.json`.
- Preserve numeric footnote labels, automatic numbering that skips reserved numbers, repeated-reference backlinks, and the small return links without sentence tooltips.
- Keep preview file access within the resolved document root. Preserve traversal and symlink checks, read and embed limits, and cycle detection. Preview features display content without executing document code.
- Preserve keyboard folding, folding state across preview refreshes, accessible tab interaction, and SVG sanitization for custom callout icons.

### Root and compatibility behavior

The preview currently uses legacy `FileVault`/`discoverVault` names in `src/vault.ts`. In ordinary Markdown folders it falls back to the workspace folder, or the containing folder for a standalone file. Existing compatibility behavior can discover a nearest `.obsidian` directory or use `obsidianMarkdown.vaultRoot`; retain this behavior unless the task explicitly changes it. Keep it separate from user-facing setup instructions.

Settings and command IDs retain the `obsidianMarkdown.*` prefix for compatibility. The existing manual preview-index refresh command is `Markdown Chroma: Refresh Vault Index` (`obsidianMarkdown.refreshVault`). Renaming documentation does not authorize changing these IDs or runtime behavior.

### Index, CLI, and MCP

- Keep CLI and MCP queries on the same root-bound `IndexService`. Export the shared API and TypeScript declarations through `markdown-chroma/index`.
- The index uses an explicit root, defaults to the current directory, and does not depend on `.obsidian` configuration or indexes. Do not add special handling for Obsidian `%%…%%` comments or block IDs without an explicit scope change; preview support differs from index support.
- List section IDs and labels before reading sections; do not guess source line ranges. Preserve exact source ranges and source-hash checks for stale reads.
- Refresh saved-file snapshots on queries, reuse unchanged parsed records, and preserve cache locking, cancellation-aware waits, and serialized requests. Do not store full document bodies or ASTs in the persistent cache.
- Preserve typed AND search filters, deterministic term selection, request order, deduplication of identical selections, and successful items in partial reads. Report `complete: false` with diagnostics or per-item errors when results are partial.
- Keep MCP stdout protocol-only and launch errors on stderr. Requests cannot change the server root. SDK validation errors may have text content without `structuredContent`; handle both response forms.
- Streamable HTTP uses the same root-bound service through the SDK's public handler. Bind loopback by default; validate Host and Origin headers, require the environment-supplied Bearer token for non-loopback access, and keep tokens out of URLs and logs. Retain stdio as the default and the VS Code provider transport.
- CLI watch and MCP background watching share `startIndexWatch`. Debounce events, retain periodic full hash scans and query-time refresh, skip the same excluded trees and cache paths as traversal, reattach replaced directories, and cancel lock waits and release watches on shutdown.
- Offer MCP servers only for trusted local workspace folders. Validate configured roots and recheck definitions before launch. Use the VS Code host runtime and retain preview support on older hosts without the MCP provider API.

## Developer references

- [VS Code Markdown Extension API](https://code.visualstudio.com/api/extension-guides/markdown-extension)
- [VS Code MCP extension API](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [Official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
