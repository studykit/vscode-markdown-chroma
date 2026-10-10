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

The default output is a title outline:

```text
Installation
  macOS
```

Read a listed title with an exact, case-sensitive match:

```sh
markdown-chroma read-section guide.md --root ./notes --title 'Installation'
```

If a title appears more than once, the error lists candidate heading paths. Select the full path as a JSON array, including the selected title:

```sh
markdown-chroma read-section guide.md --root ./notes --heading-path '["Installation","macOS"]'
```

If the full path also appears more than once, candidates include IDs for those sections; use `--id` to select one. `--label` remains available for MyST heading labels. Specify exactly one of `--title`, `--heading-path`, `--id`, or `--label`.

Section reads include child sections by default. Add `--no-children` for the selected section's own body. Reads return the original Markdown; add `--json` to receive the file and `content` as retrieval JSON.

`sections ... --json` returns a title tree. For troubleshooting, `--debug` returns detailed section records, including IDs, labels, line ranges, and `sourceHash`. Pass that hash to `read-section ... --source-hash '<listed-hash>'` when the read must match the previous listing. A titleless preamble is shown as `[preamble]` and can be read with `--id preamble`; an empty document produces no outline.

## Explore tables, images, and terms

```sh
markdown-chroma tables --root ./notes
markdown-chroma images --root ./notes
markdown-chroma glossaries --root ./notes
markdown-chroma terms --root ./notes
markdown-chroma read-term 'AST' 'MyST Markdown' --root ./notes
```

Table lists show captions, headers, and the owning heading path. Image lists show sources, alt text, captions, and the owning heading path. Read that section for the surrounding content. MyST glossaries, term definitions, and `{term}` references are indexed across the root. If several definitions have the same name, narrow the selection to a file or use an ID from the ambiguity candidates or a `--json` list.

Term lists show names and files:

```text
- AST (glossary.md)
- Directive (glossary.md)
```

Read a definition by the name used in the document:

```sh
markdown-chroma read-term 'Directive' --root ./notes
markdown-chroma read-term 'Directive' --file glossary.md --root ./notes
```

Use a glossary to keep shared definitions together and refer to them from multiple documents with MyST `{term}`. Reading one term is useful for a specific definition; reading the whole glossary gives the context of related terms. List glossaries, then select one by its owning section title:

```sh
markdown-chroma glossaries --root ./notes
markdown-chroma read-glossary glossary.md --title 'Authoring terms' --root ./notes
```

Duplicate glossary titles can be selected with `--heading-path '["Guide","Authoring terms"]'`. If several glossaries share the same heading path, or a glossary has no owning heading, use an ID shown in the list or error candidates.

You can read selected terms and glossaries together, using actual IDs from the list responses:

```sh
markdown-chroma read --root ./notes --id '<term-id>' --id '<glossary-id>'
```

Batch reads preserve your selection order and remove identical repeated selections. If an item cannot be read, successful items are still returned with errors for the missing items.

## Keep the index up to date

```sh
markdown-chroma watch --root ./notes
```

Watch indexes once at startup, then groups save, creation, rename, and deletion events over 300 ms before refreshing. It covers Markdown, MyST configuration, bibliography, and attachment changes. A full hash scan every 30 seconds covers missed events. Stop it with `Ctrl+C`.

Watch writes text updates such as `Indexed 12 documents.` and writes issues or failures to stderr. Add `--json` for concise JSON Lines, or `--debug` for full refresh metadata. Change its timing with `--debounce-ms` and `--poll-interval-ms`:

```sh
markdown-chroma watch --root ./notes --debounce-ms 300 --poll-interval-ms 30000
```

Queries also refresh saved-file snapshots, so watch is optional. Unsaved edits belong to the VS Code preview and are not read by the CLI or MCP server.

## Output

| Option | Output |
| --- | --- |
| Default | Readable text lists, section title outlines, and original Markdown reads |
| `--json` | Retrieval JSON with files, titles or names, selection choices, content, and partial-result issues; the same information as MCP |
| `--debug` | Detailed JSON records for troubleshooting, including hashes, source ranges, parsing statistics, and cache paths where applicable |

`--debug` takes precedence if both options are supplied. Ordinary queries return one JSON result; watch emits one JSON object per update. Default errors and ambiguous choices go to stderr; JSON errors retain codes and candidates.

## Cache and limits

- The cache lives in the user cache directory under `markdown-chroma`, separately for each root. Use `--cache-dir` to choose another location. `index --rebuild` reparses everything.
- `.md` and `.markdown` documents are indexed. Hidden paths, `node_modules`, `_build`, symlinks, and the root's cache directory are excluded.
- MyST configuration and document frontmatter apply to parsing. Source, configuration, and bibliography files each have a 2 MiB limit.
- Default responses and `--json` contain information for finding and reading content. Internal index records are available through `--debug` and the public Node API.
- Partial results exit with code `1` and issues go to stderr; JSON results also have `complete: false`. Invalid arguments exit with code `2`. Ambiguous choices provide candidates for the next read.
- Index support differs from preview support: Obsidian block IDs and `%%…%%` comments have no special index handling. External table data is neither executed nor downloaded.

The [index specification](CLI-INDEX-SPEC.md) describes all commands, selection rules, records, and diagnostics. The [MCP guide](MCP.md) covers the same features for MCP clients and the public Node API.
