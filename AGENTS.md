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

## Implementation constraints

### Preview

- Extend the built-in Markdown Preview through `extendMarkdownIt`; preserve native themes, navigation, scroll synchronization, frontmatter rendering, and ordinary code blocks.
- Parsing rules create tokens without reading files. Resolve links and embeds at render time using the current document URI supplied by VS Code. Preserve source context across cached tokens, multiple open previews, and nested embeds.
- Reflect unsaved contents of open documents in preview embeds. CLI and MCP reads use saved files instead.
- Bundle the official `myst-parser`, `myst-transforms`, and directive extensions. Use public extension points and project wrappers; do not patch or fork MyST dependencies. The current parser version is pinned in `package.json`.
- Preserve numeric footnote labels, automatic numbering that skips reserved numbers, repeated-reference backlinks, and the small return links without sentence tooltips.
- Keep preview file access within the resolved document root. Preserve traversal and symlink checks, read and embed limits, and cycle detection. Default rendering does not execute document code. Project JavaScript plugins require both workspace trust and the explicit `markdownChroma.preview.projectPlugins` setting; never execute them for a standalone file or through CLI/MCP indexing.
- Run preview plugin parsing in a bounded Worker, refresh when async results arrive, clone cached ASTs before transforms, and isolate module graphs by root and plugin set. Use the public Node module hooks to provide bundled MyST imports and installed local dependencies. Workers isolate crashes/timeouts, not file or network permissions. Reload saved modules and dependency graphs on changes or manual refresh; ignore frontmatter plugin declarations. Support synchronous directive/role callbacks only, keep built-in definitions authoritative, and retain actionable failures without losing ordinary content.
- Keep plugin Output history bounded and contextual, deduplicate unchanged diagnostic reports, and publish Problems only with reliable document positions. Preserve failures across worker eviction until saved changes or explicit reload. `markdownChroma.reloadProjectPlugins` reloads the current document's registered plugin set; `markdownChroma.showProjectPluginLogs` opens its log channel. Debounce broad saved-file invalidation per root and coalesce queued source versions per document/settings context without dropping other documents or embeds. Obsolete parse completions must not publish stale Problems or trigger redundant refreshes.
- Preserve keyboard folding, folding state across preview refreshes, accessible tab interaction, and SVG sanitization for custom callout icons.

### Root and compatibility behavior

The preview uses `resolvePreviewRoot` in `src/vault.ts`. Its default is the workspace folder, or the containing folder for a standalone file. `markdownChroma.preview.root` can narrow the root to an existing directory inside the workspace that contains the source document; invalid directories and symlink escapes fall back to the default. This boundary applies to ordinary Markdown, Obsidian Markdown, and MyST file access. An `.obsidian` directory does not select the root. Keep optional MyST configuration discovery inside this boundary. The internal `FileVault` class name is retained.

The shared preview settings are `markdownChroma.preview.root` and `markdownChroma.preview.maxEmbedDepth`. The depth setting applies to Obsidian note embeds and MyST includes/embeds. Existing command IDs retain the `obsidianMarkdown.*` prefix for compatibility. The existing manual preview-index refresh command is `Markdown Chroma: Refresh Vault Index` (`obsidianMarkdown.refreshVault`). Renaming documentation does not authorize changing these command IDs or runtime behavior.

### Index, CLI, and MCP

- Keep CLI and MCP queries on the same root-bound `IndexService`. Export the shared API and TypeScript declarations through `markdown-chroma/index`.
- Explicit `expand-directive` / MCP `expand_directive` is separate from indexing and ordinary reads. Select only an observed saved-source opening line, use authored arguments/options/body, preserve ambiguity, and never execute callbacks from unrelated document occurrences. Local include/embed reads need no plugin capability; JavaScript requires CLI/server launch opt-in (the trusted VS Code provider uses `markdownChroma.mcp.projectPlugins`). Ignore frontmatter executable declarations. Bound nesting, cycles, source occurrence count, output characters and worker resources; return readable content with accurate partial status and source context, never persist generated output. Fresh workers avoid stale module graphs and untracked fs data. Keep execution annotations honest: Node plugins can have side effects and workers are not permission sandboxes.
- The index uses an explicit root, defaults to the current directory, and does not depend on `.obsidian` configuration or indexes. Do not add special handling for Obsidian `%%…%%` comments or block IDs without an explicit scope change; preview support differs from index support.
- List section titles before title-based reads, or use observed grep/rg line locations for source/section reads; do not guess document positions. CLI `sections` defaults to a title outline and MCP returns a title tree. Read by exact title or full heading path; preserve ID/label selection, explicit ambiguity errors, exact source ranges, and source-hash checks for stale reads.
- Keep default CLI output as readable text, with titles and term names as the primary choices. CLI `--json` and MCP use the shared concise retrieval presentation. Do not expose index internals such as cache paths, versions, hashes, parser ranges/identifiers, or outgoing records in these outputs. Observed external search line numbers may be used for source/section reads. Preserve actionable candidates, original content, and partial-result issues. Explicit CLI `--debug` and the Node API retain full records; `--debug` takes precedence over `--json`.
- Summarize retrieval diagnostics once and scope file/section/explicit-item reads to the requested content. Keep file-wide configuration/frontmatter failures relevant, global discovery and backlinks conservative, and per-item failures partial. Full Node/debug results retain snapshot-wide diagnostics and completeness. Traverse MyST `+++` document blocks for document headings while excluding headings local to directives, quotes, and code; bump the wrapper parser version when persisted parsing behavior changes.
- Inspect registered local MyST plugin declarations without executing or downloading code. Confirm names and aliases through static JavaScript default exports or literal Python `plugin` dictionaries; do not infer names from arbitrary strings or path registration alone. Keep plugin paths relative to the declaring configuration and include plugin hashes in cache invalidation. Distinguish `pluginContentNotIndexed` / `pluginDefinitionsUnavailable` from real syntax errors. Discovery and name-only term selection retain generation limitations; successful explicit saved-source reads ignore generation limitations but retain configuration failures. The separate opt-in Preview runtime does not change index behavior.
- Read whole glossaries by file and owning section title or heading path. Preserve listed IDs for unlabeled or indistinguishable glossaries and batch selections. Never select the first match when a title or path is ambiguous.
- Refresh saved-file snapshots on structural queries (line reads bypass parsing/cache refresh), reuse unchanged parsed records, and preserve cache locking, cancellation-aware waits, and serialized requests. Do not store full document bodies or ASTs in the persistent cache.
- Preserve typed AND search filters, deterministic term selection, request order, deduplication of identical selections, and successful items in partial reads. Report `complete: false` with diagnostics or per-item errors when results are partial.
- Natural-name batches share `read` / MCP `read_items`: default sections to their own body, merge overlapping saved-source ranges once at their first requested position, and preserve exact original content. Enforce the Unicode-character source budget by omitting whole merged ranges and retaining later items that fit. Report omissions as partial results; do not describe characters as model tokens. Keep legacy term/glossary ID reads compatible.
- Resolve text-bearing fragment-only Markdown links against explicit project labels before ordinary local heading fragments. Retain ambiguity rather than choosing a duplicate global label; refresh resolved references even when parsed document records are reused.
- Use external grep/rg/sed for source string search; do not expose a duplicate `match` command or MCP `match_text` tool. `read-lines` / `read_lines` reads selected saved source through the same serialized `IndexService` without index refresh/cache locks. Preserve root, UTF-8, size, symlink, cache/traversal exclusions and stable-read checks. `read-section --line` / MCP `line` selects the section owning an observed external-search line and retains structural refresh/hash checks.
- Keep MCP stdout protocol-only and launch errors on stderr. Requests cannot change the server root. SDK validation errors may have text content without `structuredContent`; handle both response forms.
- Streamable HTTP uses the same root-bound service through the SDK's public handler. Bind loopback by default; validate Host and Origin headers, require the environment-supplied Bearer token for non-loopback access, and keep tokens out of URLs and logs. Retain stdio as the default and the VS Code provider transport.
- CLI watch and MCP background watching share `startIndexWatch`. Debounce events, retain periodic full hash scans and query-time refresh, skip the same excluded trees and cache paths as traversal, reattach replaced directories, and cancel lock waits and release watches on shutdown.
- Offer MCP servers only for trusted local workspace folders. Validate configured roots and recheck definitions before launch. Use the VS Code host runtime and retain preview support on older hosts without the MCP provider API.

## Developer references

- [MyST retrieval benchmark and token analysis](docs/benchmarks/MYSTMD-RETRIEVAL.md)
- [MyST benchmark after batch reads: three trials per condition](docs/benchmarks/MYSTMD-BATCH-RETRIEVAL.md)
- [VS Code Markdown Extension API](https://code.visualstudio.com/api/extension-guides/markdown-extension)
- [VS Code MCP extension API](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [Official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
