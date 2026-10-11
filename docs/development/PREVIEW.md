# Preview implementation guide

Read [AGENTS.md](../../AGENTS.md) for common working rules and the [preview guide](../PREVIEW.md) for user-facing behavior. Apply these constraints when changing preview parsing, rendering, document roots, or project plugin execution.

## Preview

- Extend the built-in Markdown Preview through `extendMarkdownIt`; preserve native themes, navigation, scroll synchronization, frontmatter rendering, and ordinary code blocks.
- Parsing rules create tokens without reading files. Resolve links and embeds at render time using the current document URI supplied by VS Code. Preserve source context across cached tokens, multiple open previews, and nested embeds.
- Reflect unsaved contents of open documents in preview embeds. CLI and MCP reads use saved files instead.
- Bundle the official `myst-parser`, `myst-transforms`, and directive extensions. Use public extension points and project wrappers; do not patch or fork MyST dependencies. The current parser version is pinned in `package.json`.
- Preserve numeric footnote labels, automatic numbering that skips reserved numbers, repeated-reference backlinks, and the small return links without sentence tooltips.
- Keep preview file access within the resolved document root. Preserve traversal and symlink checks, read and embed limits, and cycle detection. Default rendering does not execute document code. Project JavaScript plugins require both workspace trust and the explicit `markdownChroma.preview.projectPlugins` setting; never execute them for a standalone file or through CLI/MCP indexing.
- Run preview plugin parsing in a bounded Worker, refresh when async results arrive, clone cached ASTs before transforms, and isolate module graphs by root and plugin set. Use the public Node module hooks to provide bundled MyST imports and installed local dependencies. Workers isolate crashes/timeouts, not file or network permissions. Reload saved modules and dependency graphs on changes or manual refresh; ignore frontmatter plugin declarations. Support synchronous directive/role callbacks only, keep built-in definitions authoritative, and retain actionable failures without losing ordinary content.
- Keep plugin Output history bounded and contextual, deduplicate unchanged diagnostic reports, and publish Problems only with reliable document positions. Preserve failures across worker eviction until saved changes or explicit reload. `markdownChroma.reloadProjectPlugins` reloads the current document's registered plugin set; `markdownChroma.showProjectPluginLogs` opens its log channel. Debounce broad saved-file invalidation per root and coalesce queued source versions per document/settings context without dropping other documents or embeds. Obsolete parse completions must not publish stale Problems or trigger redundant refreshes.
- Preserve keyboard folding, folding state across preview refreshes, accessible tab interaction, and SVG sanitization for custom callout icons.

## Root and compatibility behavior

The preview uses `resolvePreviewRoot` in `src/vault.ts`. Its default is the workspace folder, or the containing folder for a standalone file. `markdownChroma.preview.root` can narrow the root to an existing directory inside the workspace that contains the source document; invalid directories and symlink escapes fall back to the default. This boundary applies to ordinary Markdown, Obsidian Markdown, and MyST file access. An `.obsidian` directory does not select the root. Keep optional MyST configuration discovery inside this boundary. The internal `FileVault` class name is retained.

The shared preview settings are `markdownChroma.preview.root` and `markdownChroma.preview.maxEmbedDepth`. The depth setting applies to Obsidian note embeds and MyST includes/embeds. Existing command IDs retain the `obsidianMarkdown.*` prefix for compatibility. The existing manual preview-index refresh command is `Markdown Chroma: Refresh Vault Index` (`obsidianMarkdown.refreshVault`). Renaming documentation does not authorize changing these command IDs or runtime behavior.
