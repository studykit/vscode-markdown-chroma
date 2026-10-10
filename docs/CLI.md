# Markdown Chroma CLI

Search a folder of Markdown files and read the sections, terms, and glossaries you need. The CLI runs independently of VS Code and works with ordinary Markdown folders as well as Obsidian and MyST documents.

[Back to the overview](../README.md) · [MCP server](MCP.md) · [Detailed index specification](CLI-INDEX-SPEC.md)

## Install

Install Node.js 20 or later, then install the packaged npm archive:

```sh
npm install -g ./markdown-chroma-0.1.0.tgz
markdown-chroma --help
```

This installs both `markdown-chroma` and `markdown-chroma-mcp`. For building from source, see [developer setup](../AGENTS.md).

## Start with your notes folder

```sh
markdown-chroma index --root ./notes
markdown-chroma notes --root ./notes
```

`--root` selects the folder to search. It defaults to your current working directory, and relative paths are resolved there. File arguments such as `guide.md` are exact paths within that root. The index does not require `.obsidian` files.

## Find notes

```sh
markdown-chroma search --root ./notes --tag project
markdown-chroma search --root ./notes --where '{"status":"draft"}'
markdown-chroma search --root ./notes --tag project --has-property author
markdown-chroma backlinks guide.md --root ./notes
```

Combined filters use AND. Tags include descendants, so `--tag project` also matches `#project/launch`; add `--exact-tag` for an exact match. Property searches accept JSON strings, numbers, booleans, and null, and can match a member of an array property.

## Read a section

List a document's sections first:

```sh
markdown-chroma sections guide.md --root ./notes
```

Choose an ID or label from that response, then read it:

```sh
markdown-chroma read-section guide.md --root ./notes --id '<section-id>'
```

Replace `<section-id>` with an actual listed ID. Section reads include child sections by default. Add `--no-children` for the selected section's own body, or `--source-hash '<listed-hash>'` to check that the document has not changed since listing. Reads return the original Markdown; add `--json` for metadata and `content`.

## Explore tables, images, and terms

```sh
markdown-chroma tables --root ./notes
markdown-chroma images --root ./notes
markdown-chroma glossaries --root ./notes
markdown-chroma terms --root ./notes
markdown-chroma read-term 'AST' 'MyST Markdown' --root ./notes --json
```

Tables and images are listed with their positions and metadata. MyST glossaries, term definitions, and `{term}` references are indexed across the root. If several definitions have the same name, narrow the selection to a file or use the global IDs returned by the lists.

You can read selected terms and glossaries together, using actual IDs from the list responses:

```sh
markdown-chroma read --root ./notes --id '<term-id>' --id '<glossary-id>' --json
```

Batch reads preserve your selection order and remove identical repeated selections. If an item cannot be read, successful items are still returned with errors for the missing items.

## Keep the index up to date

```sh
markdown-chroma watch --root ./notes
```

Watch indexes once at startup, then groups save, creation, rename, and deletion events over 300 ms before refreshing. It covers Markdown, MyST configuration, bibliography, and attachment changes. A full hash scan every 30 seconds covers missed events. Stop it with `Ctrl+C`.

Each refresh checks the file list and hashes, reusing unchanged parsed documents. Watch writes one JSON object per line for the initial snapshot and each changed snapshot, and writes failures to stderr. Change its timing with `--debounce-ms` and `--poll-interval-ms`:

```sh
markdown-chroma watch --root ./notes --debounce-ms 300 --poll-interval-ms 30000
```

Queries also refresh saved-file snapshots, so watch is optional. Unsaved edits belong to the VS Code preview and are not read by the CLI or MCP server.

## Cache, output, and limits

- The cache lives in the user cache directory under `markdown-chroma`, separately for each root. Use `--cache-dir` to choose another location. `index --rebuild` reparses everything.
- `.md` and `.markdown` documents are indexed. Hidden paths, `node_modules`, `_build`, symlinks, and the root's cache directory are excluded.
- MyST configuration and document frontmatter apply to parsing. Source, configuration, and bibliography files each have a 2 MiB limit.
- Lists and searches return JSON. Partial results have `complete: false` and exit code `1`; invalid arguments exit with code `2`. Diagnostics go to stderr.
- Index support differs from preview support: Obsidian block IDs and `%%…%%` comments have no special index handling. External table data is neither executed nor downloaded.

The [index specification](CLI-INDEX-SPEC.md) describes all commands, selection rules, records, and diagnostics. The [MCP guide](MCP.md) covers the same features for MCP clients and the public Node API.
