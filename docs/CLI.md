# Markdown Chroma CLI

Search a folder of Markdown files and read the sections, terms, and glossaries you need. The CLI runs independently of VS Code and works with ordinary Markdown folders as well as Obsidian and MyST documents.

[Back to the overview](../README.md) · [MCP server](MCP.md) · [Detailed index specification](CLI-INDEX-SPEC.md)

## Install

Install Node.js 20 or later, then install the public npm package:

```sh
npm install -g markdown-chroma
markdown-chroma --help
```

This installs both `markdown-chroma` and `markdown-chroma-mcp` from the same package. To run the CLI without a global installation:

```sh
npx --yes markdown-chroma@0.1.0 notes --root ./notes
```

Use a specific version in automated setups. You can also install a downloaded archive with `npm install -g ./markdown-chroma-0.1.0.tgz`. For building from source, see [developer setup](../AGENTS.md).

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

## Combine shell search with Chroma reads

Use existing shell tools such as `grep`, `rg`, and `sed` to find source text. Chroma provides structural discovery and reads rather than a built-in string-search command.

```sh
rg -n -F 'cache' ./notes
markdown-chroma read-lines guide.md --start 40 --end 50 --root ./notes
markdown-chroma read-section guide.md --line 42 --root ./notes
```

The read examples assume the shell search found `notes/guide.md` near line 42. Use actual observed line locations. `read-lines` preserves original source and line endings; omit `--end` to read up to 20 lines from `--start`, clamped at EOF. A start past EOF is an error. `read-section --line` reads the deepest indexed section owning that line. YAML has no section and can be read with `read-lines` or `read-frontmatter`.

Line reads access saved source directly without creating, locking, or refreshing the structural index. Section and metadata queries retain their normal refresh. Reads keep root, symlink, UTF-8, 2 MiB and traversal/cache exclusions. An optional `--source-hash` rejects changed source using a hash from a prior debug read.

`read-lines --json` returns only `complete`, `file`, and `content`. Its debug output also includes the actual range and hash. Chroma uses saved files, so shell search and subsequent reads should operate on the same saved project root.

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

If the full path also appears more than once, candidates include IDs for those sections; use `--id` to select one. `--label` remains available for MyST heading labels. Specify exactly one of `--title`, `--heading-path`, `--id`, `--label`, or an observed `--line`.

Section reads include child sections by default. Add `--no-children` for the selected section's own body. Reads return the original Markdown; add `--json` to receive the file and `content` as retrieval JSON.

`sections ... --json` returns a title tree. For troubleshooting, `--debug` returns detailed section records, including IDs, labels, line ranges, and `sourceHash`. Pass that hash to `read-section ... --source-hash '<listed-hash>'` when the read must match the previous listing. A titleless preamble is shown as `[preamble]` and can be read with `--id preamble`; an empty document produces no outline.

## Expand a directive or document embed

Read the original source first. When an include, embed, or custom directive contains information needed for your answer, request that occurrence's expanded content:

```sh
rg -n 'include|embed|demo:greeting' ./notes/guide.md
markdown-chroma expand-directive guide.md --line 42 --root ./notes
```

Use the actual opening line reported by your source read or search; `42` is illustrative. Selection does not use a guessed section position or accept replacement Markdown. Multiple embeds on one line are ambiguous. Directives inside code fences, inline code, comments, or frontmatter are not selected.

Local MyST `include`, `literalinclude`, and `embed`, and Obsidian document/heading embeds read saved targets inside the root. Include line/marker filters are applied; literal includes return fenced code. MyST labels can select headings or indexed content blocks. Missing or duplicate targets are reported rather than chosen silently.

Custom JavaScript directives require explicit permission for that CLI invocation:

```sh
markdown-chroma expand-directive guide.md --line 42 --allow-project-plugins --root ./notes
```

Only local ESM plugins registered in `myst.yml`/`myst.yaml`, including local `extends`, are loaded. Page frontmatter cannot register executable plugins. Names, aliases, arguments, option aliases, and synchronous callbacks follow the supported [Preview plugin API](PREVIEW.md#project-defined-myst-plugins). Only the selected occurrence and permitted nested callbacks run; other occurrences in the document are excluded. Loading a module still executes its initialization code. Plugins have ordinary Node file/network access; workers bound time and crashes, not permissions. Custom execution requires Node.js 20.6 or later.

`--max-depth` defaults to `1` (range `1`–`10`): expand the selected occurrence and retain further nested syntax. Increase it to expand nested content. Cycles and more than 32 source occurrences are stopped. `--max-chars` defaults to `12000` Unicode characters (maximum `200000`); truncated results are partial. A plugin load/parse has a two-second deadline and the existing memory/AST/result limits. Unsupported generated nodes preserve readable children with an issue. Failures retain useful content or the selected original syntax.

Default output is readable Markdown. `--json` returns `complete`, source file/line, directive name, content, contributing sources, and any issues; it matches MCP. `--debug` additionally retains source hashes/ranges, diagnostics and bounded worker logs. An optional `--source-hash` rejects a source changed since a debug read. Results come from current saved files and fresh plugin workers, so saved helpers and local data changes are reflected without a Preview session.

Expansion does not write generated content into the persistent index. Ordinary indexing, watching, and `read` operations never execute plugins or expand references. Remote content, notebook outputs, Obsidian block IDs, Python/executable plugins, transforms, asynchronous callbacks, and standalone custom-role expansion are outside this version.

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

## Read several pieces of evidence at once

After finding files with shell tools and listing their section titles or terms, select the needed source in one request:

```sh
markdown-chroma read --root ./notes --select '[
  {"kind":"section","file":"guide.md","title":"Installation"},
  {"kind":"section","file":"guide.md","headingPath":["Installation","macOS"]},
  {"kind":"term","file":"glossary.md","name":"AST"}
]' --max-chars 12000
```

Batch sections return their own body by default. Set `"includeChildren":true` on a section selection to include its descendants. A section requires `file` and exactly one of `title`, `headingPath`, `id`, `label`, or an observed `line`. A term requires `name`; add `file` when the name has multiple definitions. Ambiguous selections return candidates alongside the other successful reads.

The batch accepts up to 100 selections. It removes repeated selections and merges overlapping source ranges within a file, preserving the original Markdown and line endings. A merged range appears at the position of its first selection; its `covers` information identifies the other selections included in that content. Separate ranges stay in request order.

`--max-chars` limits returned source to 12,000 Unicode characters by default (allowed range: 1–200,000). It is a source-length budget, not a model token count, and excludes response labels and diagnostics. A whole merged range that does not fit is omitted; later, smaller ranges can still fit. The CLI reports each omission on stderr and exits with status 1. Retry a smaller selection or raise the budget to retrieve omitted content. It never silently cuts a definition or code block in half. If a selected parent and child overlap, they are one range; retry the child alone if the combined range is too large.

`--json` returns content, natural selection names, and per-item errors or omissions. It includes the budget only when source was omitted. `--debug` retains ranges, hashes, statuses, and the budget for every batch. File-scoped selections exclude unrelated document issues; a term selected without `file` retains project-wide completeness.

You can also read selected terms and glossaries together using actual IDs from the list responses:

```sh
markdown-chroma read --root ./notes --id '<term-id>' --id '<glossary-id>'
```

This ID mode preserves selection order and removes repeated IDs. It retains separate term and glossary content, including overlaps, and does not accept `--select` or `--max-chars`. In either mode, successful items remain available when another selection fails.

## Keep the index up to date

```sh
markdown-chroma watch --root ./notes
```

Watch indexes once at startup, then groups save, creation, rename, and deletion events over 300 ms before refreshing. It covers Markdown, MyST configuration, local plugin definitions, bibliography, and attachment changes. A full hash scan every 30 seconds covers missed events. Stop it with `Ctrl+C`.

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

Ordinary queries report one short summary when relevant content could not be fully indexed. File and section reads ignore unrelated parsing issues elsewhere in the project; global searches and backlinks remain project-wide. Use `markdown-chroma index --root ./notes --debug` for all diagnostic messages. Detailed output uses project-wide status, so its exit code may differ from a successful scoped read.

## MyST project plugins

Local plugins registered in `project.plugins` in `myst.yml` or `myst.yaml` are inspected automatically, without executing their code. Chroma recognizes literal role/directive names and aliases from JavaScript default exports and executable Python plugins with a top-level literal `plugin` dictionary. Paths follow the configuration file that declares them, including inherited configuration.

Confirmed names do not produce unknown role/directive errors. Unknown names and ordinary MyST option errors still produce diagnostics. Remote plugins, other executables, imported or computed specifications, and unreadable files cannot be inspected; registering a path alone does not confirm its names. Custom plugin options and callback behavior are not validated.

Plugins can generate headings, terms, images, or references that are absent from saved Markdown. Structural lists, searches, and backlinks report `complete: false` with a short explanation when plugin output may affect them. Explicit source reads still return the original Markdown and ignore this generation limitation; name-only term reads retain project-wide completeness. Configuration or inspection failures remain relevant. `--debug` distinguishes `pluginContentNotIndexed`, `pluginDefinitionsUnavailable`, and actual `mystSyntax` diagnostics.

Use [explicit expansion](#expand-a-directive-or-document-embed) to read generated content at a saved occurrence. This is separate from static indexing and source reads.

## Cache and limits

- The cache lives in the user cache directory under `markdown-chroma`, separately for each root. Use `--cache-dir` to choose another location. `index --rebuild` reparses everything.
- `.md` and `.markdown` documents are indexed. Hidden paths, `node_modules`, `_build`, symlinks, and the root's cache directory are excluded.
- MyST configuration and document frontmatter apply to parsing. Source, configuration, local plugin, and bibliography files each have a 2 MiB limit. Plugin edits invalidate affected cached records.
- Default responses and `--json` contain information for finding and reading content. Internal index records are available through `--debug` and the public Node API.
- Partial results exit with code `1` and issues go to stderr; JSON results also have `complete: false`. Invalid arguments exit with code `2`. Ambiguous choices provide candidates for the next read.
- Index support differs from preview support: Obsidian block IDs and `%%…%%` comments have no special index handling. External table data is neither executed nor downloaded.

The [index specification](CLI-INDEX-SPEC.md) describes all commands, selection rules, records, and diagnostics. The [MCP guide](MCP.md) covers the same features for MCP clients and the public Node API.
