# Development guide

Developer setup, build commands, runtime verification, and the source map for Markdown Chroma. See [AGENTS.md](../AGENTS.md) for common working rules. Source paths below are relative to the repository root.

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

The npm package contains both CLI executables and the `markdown-chroma/index` API. Verify the packed archive in an isolated consumer project, including CLI commands, MCP calls and API declarations. Keep version numbers, archive names and pinned `npx` examples aligned.

## Runtime verification

Press F5 to launch the Extension Development Host. The launch configuration disables installed extensions to keep the development host isolated. It opens `examples/vault`; this is a fixture directory name, not a requirement to use an Obsidian vault. Open `Showcase.md` in the built-in Markdown Preview to inspect Obsidian syntax, local media, and embeds. MyST examples are in `examples/myst`. The English `preview-demo.md` files in both folders are used for README screenshots.

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
| Opt-in MyST preview plugin lifecycle, diagnostics, isolated parsing, and local module loading | `src/myst-options.ts`, `src/preview-plugins/manager.ts`, `src/preview-plugins/events.ts`, `src/preview-plugins/diagnostics.ts`, `src/preview-plugins/worker.ts`, `src/preview-plugins/loader.ts` |
| Preview styles, folding, icons, and tabs | `media/preview.css`, `media/preview.js` |
| Persistent indexing, parsing, static plugin inspection, source reads, records, shared queries, batch reads, retrieval responses, and file watching | `src/index/project.ts`, `src/index/parser.ts`, `src/index/plugins.ts`, `src/index/types.ts`, `src/index/query.ts`, `src/index/batch.ts`, `src/index/presentation.ts`, `src/index/paths.ts`, `src/index/watch.ts`, `src/index/watch-cli.ts` |
| CLI entry point and argument handling | `src/cli.ts`, `src/index/cli.ts` |
| Explicit saved-source directive/include/embed expansion, selection and readable output | `src/index/expansion.ts`, `src/index/expansion-source.ts`, `src/preview-plugins/expansion-parser.ts` |
| Public Node API exports | `src/index/index.ts` |
| MCP entry point, transport selection, stdio / HTTP lifecycle, and tools | `src/mcp.ts`, `src/mcp/cli.ts`, `src/mcp/stdio.ts`, `src/mcp/http.ts`, `src/mcp/server.ts` |
| VS Code MCP server definitions | `src/mcp-provider.ts` |
| Bundles, assets, notices, and API declarations | `scripts/build.mjs`, `tsconfig.api.json` |
| Unit and host integration tests | `test/`, `scripts/test-integration.mjs` |

## Developer references

- [MyST retrieval benchmark and token analysis](benchmarks/MYSTMD-RETRIEVAL.md)
- [MyST benchmark after batch reads: three trials per condition](benchmarks/MYSTMD-BATCH-RETRIEVAL.md)
- [VS Code Markdown Extension API](https://code.visualstudio.com/api/extension-guides/markdown-extension)
- [VS Code MCP extension API](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [Official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
