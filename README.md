# Markdown Chroma

Render **Obsidian Flavored Markdown and MyST / Jupyter Book 2 syntax** together in VS Code's built-in Markdown Preview. Use ordinary Markdown folders with wikilinks, note embeds, callouts, footnotes, and MyST directives and roles.

## Getting started

Install the extension from a VSIX file with VS Code's `Extensions: Install from VSIX...` command, then:

1. Open a folder containing Markdown files in VS Code.
2. Open a Markdown document.
3. Run `Markdown: Open Preview to the Side` or `Markdown Chroma: Open Preview to the Side`. The shortcut is `Cmd+K V` on macOS or `Ctrl+K V` on Windows/Linux.

The extension works with the built-in Markdown theme, preview navigation, and scroll synchronization. Changes to open documents appear in the preview before you save them.

## Obsidian Markdown rendering

Obsidian Flavored Markdown renders directly in the built-in Preview. Wikilinks navigate to documents, headings, and blocks; embeds display content from other documents. Callouts provide icons and folding, alongside highlights, comments, footnotes, and task lists.

| Feature | Examples and behavior |
| --- | --- |
| Wikilinks and display text | `[[Note]]`, `[[folder/Note\|Display text]]` |
| Heading and nested heading links | `[[Note#Heading]]`, `[[Note#Parent#Child]]`, `[[#Heading]]` |
| Block links and identifiers | `[[Note#^id]]`, `Paragraph text ^id` |
| Document, heading, and block embeds | `![[Note]]`, `![[Note#Heading]]`, `![[Note#^id]]` |
| Images and dimensions | `![[image.png\|240]]`, `![[image.png\|240x120]]`, `![250](https://example.com/image.png)`, `![alt\|240](image.png)` |
| List embeds | `![[Note#^my-list-id]]` includes the list identified by the block ID |
| Callouts | `> [!note] Title`, `[!warning]-`, `[!tip]+`, and nested callouts |
| Highlights and colors | `==highlight==`, `==🔴red==`, `==🟢green==`, with six colors |
| Comments | `%%inline comment%%` and multiline `%%…%%` comments |
| Footnotes | `[^id]` with `[^id]: Definition`, and `^[inline footnote]`. Numeric labels such as `[^3]` keep their number; automatic numbering skips reserved numbers. Small `↩` links return to references, with `↩₁ ↩₂ …` for repeated references and no sentence tooltip |
| Task lists | `- [ ]`, `- [x]`, `- [?]`, `- [-]` |
| Tags | `#tag`, `#category/subcategory` |
| Properties | YAML frontmatter uses VS Code's native renderer |
| Audio and video | `![[audio.mp3]]`, `![[video.mp4]]` |

Escape pipes as `\|` inside tables. In regular text, use `[[Note|Display text]]`. Links can omit `.md` and resolve aliases from the document's frontmatter.

Write note embeds on their own line. Heading embeds include the selected heading and its children, stopping at the next heading of the same or higher level. Append paragraph block IDs to the paragraph. For a complete list, quote, callout, or table, place the block ID on a separate line after a blank line.

### Note, image, audio, and list embeds

```markdown
![[My note]]
![[My note#Heading]]
![[My note#^block-id]]

![[image.png]]
![[image.png|100]]
![[image.png|100x145]]
![250](https://example.com/image.png)

![[recording.wav]]

![[My note#^my-list-id]]
```

Setting only image width preserves the aspect ratio. Setting both width and height displays the specified dimensions. Audio displays a player with playback and seeking controls. Recognized audio extensions are `.mp3`, `.wav`, `.ogg`, `.m4a`, `.flac`, `.webm`, `.aac`, and `.opus`; playback depends on VS Code's media codec support.

To embed a list, define its block ID in the source document:

```markdown
- list item 1
- list item 2

^my-list-id
```

The embed preserves nested, ordered, and task list formatting. The [Obsidian Markdown showcase](examples/vault/Showcase.md) includes local images, a playable WAV file, and a list embedded from another note.

### Callout appearance and icons

Callout titles display Lucide SVG icons. `[!info]+` starts expanded and `[!info]-` starts collapsed. Click the title or arrow, or use the keyboard, to toggle folding.

The extension supports the `.callout`, `.callout-title`, `.callout-icon`, and `.callout-content` CSS selectors. Register a CSS file with VS Code's `markdown.styles` setting to customize colors and icons:

```json
{
  "markdown.styles": ["callouts.css"]
}
```

```css
.callout[data-callout="custom-question-type"] {
  --callout-color: #8b5cf6;
  --callout-icon: lucide-alert-circle;
  --callout-border-width: 1px;
  --callout-border-opacity: 0.25;
}
```

Use the custom type in Markdown as `> [!custom-question-type]+ Title`. Colors accept CSS values such as HEX and `rgb()`, as well as Obsidian's three-number RGB format. Icons accept bundled Lucide names or an SVG value such as `--callout-icon: '<svg viewBox="0 0 24 24"><path d="M4 12h16" stroke="currentColor"/></svg>';`. SVG shapes are supported; scripts, event handlers, and external resources are discarded. Icons load from the local bundle.

### Link paths and preview settings

In an ordinary Markdown folder, the VS Code workspace folder is the document root. When opening a file without a workspace, its containing folder is used.

`folder/Note` is relative to the document root; `./Note` and `../Note` are relative to the current document. A bare filename is resolved in the current folder, then the root, then by a unique filename or alias within the root. Ambiguous links are marked as unresolved; specify a folder path to select the intended document. Missing notes are not created automatically.

Unsaved changes in open notes are included in embeds. File creation, modification, deletion, and settings changes refresh the preview. Hidden files and folders, `node_modules`, and symbolic links are excluded from document lookup.

| Setting | Default | Behavior |
| --- | --- | --- |
| `obsidianMarkdown.maxEmbedDepth` | `5` | Maximum depth of nested note embeds |
| `markdown.preview.frontMatter` | `"table"` | Built-in VS Code setting: `"table"`, `"codeBlock"`, or `"hide"` |
| `markdown.preview.breaks` | `false` | Built-in VS Code setting: display single line breaks when `true` |

## MyST / Jupyter Book 2 rendering

Render MyST directly in the built-in Markdown Preview. If a `myst.yml` file is present, the nearest configuration supplies project settings for math macros, numbering, abbreviations, bibliography, and parser options. Document frontmatter overrides project settings, and local `extends` is supported. Without a configuration file, the preview uses defaults. No project setup, separate server, or Node/npm installation is needed for the extension.

| Syntax | Preview behavior |
| --- | --- |
| Typography, blocks, and inline options | Roles, YAML/colon/inline directive options, labels, div/span, comments, and block metadata |
| Callouts and admonitions | Nested callouts and collapsible dropdowns |
| Images, figures, and videos | Image dimensions and alignment, captions, numbering, references, MP4, and local image wildcards |
| Math and equations | KaTeX math, labels, and equation references |
| Tables and code | Tables, list-table, code, and captions |
| Cross-references | In-document `[](#label)`, `@label`, `{ref}`, `{numref}`, and `{eq}`; automatic text and numbering; `{name}`, `{number}`, and `%s` substitutions. Document links use standard Markdown navigation; content hover popups are not supported |
| Embeds and includes | Local include/literalinclude, label embeds, and saved Jupyter notebook outputs |
| Citations and bibliography | Local BibTeX files selected by frontmatter or a bibliography directive |
| Proofs and exercises | Theorems, proofs, exercises, solutions, and numbering |
| Diagrams | Mermaid |
| Asides and margins | aside/margin/sidebar/topic; placed in the document flow in narrow previews |
| Grids, tabs, and cards | Responsive grids, interactive tabs, and cards |
| Glossaries, terms, and index | Glossary/term references and index metadata |

Examples: [overview](examples/myst/index.md), [layouts](examples/myst/layout.md), [syntax](examples/myst/syntax.md), and [glossaries](examples/myst/glossary.md). The glossary example covers multiple glossaries, `{term}` references, custom display text, and references placed before definitions. See the official [MyST authoring guide](https://mystmd.org/guide), [asides](https://mystmd.org/guide/asides), and [figures](https://mystmd.org/guide/figures) documentation for syntax.

The preview displays local files without executing code. Automatic DOI or external project lookup, user project plugins, Jupyter execution, `.tex` conversion, PDF/EPS/TIFF image conversion, and PDF/Word publishing are outside its scope. External iframes appear as links under the built-in Preview's security policy. Invalid or unsupported directives display an error message. Frontmatter and Obsidian footnotes retain their existing presentation.

## CLI indexing and content retrieval

The CLI runs independently of VS Code with Node.js 20 or later. Install a packaged npm archive, then view the available commands:

```sh
npm install -g ./markdown-chroma-0.1.0.tgz
markdown-chroma --help
```

```sh
markdown-chroma index --root ./notes
markdown-chroma watch --root ./notes
markdown-chroma search --root ./notes --tag project --where '{"status":"draft"}'
markdown-chroma backlinks guide.md --root ./notes
markdown-chroma sections guide.md --root ./notes
markdown-chroma read-section guide.md --root ./notes --id installation --no-children
markdown-chroma tables --root ./notes
markdown-chroma images --root ./notes
markdown-chroma glossaries --root ./notes
markdown-chroma terms --root ./notes
markdown-chroma read-term 'AST' 'MyST Markdown' --root ./notes --json
# Use global IDs returned by the lists to read terms and glossaries together.
markdown-chroma read --root ./notes --id 'glossary.md#term-ast' --id 'syntax.md#glossary-1' --json
```

File arguments are exact paths relative to `--root`, which defaults to the current directory. The CLI indexes `.md` and `.markdown` files, excluding hidden paths, `node_modules`, `_build`, and symbolic links. It applies the nearest MyST configuration inside the root and document frontmatter.

Lists and searches return JSON; reads return original Markdown. Add `--json` to a read for metadata and `content`. Batch term and glossary reads preserve request order. Missing selections return successful results alongside `complete: false` and exit code 1. Invalid arguments exit with code 2. Diagnostics go to stderr.

The index is stored under `markdown-chroma` in the user cache directory, with separate caches for each root. Use `--cache-dir` to select a location. Queries check saved file hashes and reparse changed documents; `index --rebuild` reparses everything. Use `--source-hash` for section or term reads to detect changes since listing. Source, configuration, and bibliography files have a 2 MiB limit.

`markdown-chroma watch --root ./notes` keeps the saved-file index updated until you stop it with `Ctrl+C`. It indexes once at startup, watches eligible directories, and groups file events over 300 ms before refreshing. Markdown saves, creation, deletion, renames, MyST configuration, bibliography, and attachment changes trigger refreshes. Hidden paths, `node_modules`, `_build`, symbolic links, and the root's index cache are excluded. A full hash scan every 30 seconds covers missed events and restores directory watches after replacement. Each refresh checks the root's file list and hashes and reparses only changed documents. Queries still check saved files independently.

Watch outputs one JSON object per line for the initial snapshot and subsequent snapshot changes; failures go to stderr. Adjust the timing with `--debounce-ms` and `--poll-interval-ms`. Unsaved editor changes are included only in preview rendering.

Indexing includes content inside MyST layout directives, tables, images, glossary definitions, and `{term}` references. Code, math, and parser-recognized comments do not contribute example links or tags. Unlike the preview, the index does not provide special handling for Obsidian block IDs or `%%…%%` comments. External table declarations remain `referenceOnly`; their data is neither executed nor downloaded. Unsupported parser declarations include diagnostics.

See the [CLI specification](docs/CLI-INDEX-SPEC.md) for the complete behavior.

## MCP server

The same indexing and retrieval features are available through 13 MCP tools: section listing and reads, tag and property searches, backlinks, table and image lists, terms and glossaries across the root, and batch content reads.

### Use the server bundled with the VS Code extension

1. Run `Extensions: Install from VSIX...` and select `markdown-chroma-0.1.0.vsix`.
2. Open a local folder containing Markdown files and grant Workspace Trust.
3. Open a Markdown file to activate the extension, then run `MCP: List Servers` from the Command Palette.
4. Select `Markdown Chroma: <folder name>` and start the server. Confirm server trust when prompted. VS Code discovers the tools and manages the server process and tool approvals.

This requires a VS Code host with the MCP provider API. The bundled server uses the host runtime; no separate Node.js or npm installation is required.

| Setting | Default | Behavior |
| --- | --- | --- |
| `markdownChroma.mcp.enabled` | `true` | Offer a server for the workspace folder |
| `markdownChroma.mcp.root` | `""` | Query the workspace folder; set a relative path or an absolute directory inside it to narrow the root |

Each trusted local folder in a multi-root workspace has its own server. If a server is missing, check these settings and the `Markdown Chroma MCP` output channel. An invalid root prevents the server from being offered; older hosts without the provider API retain preview support.

### Install a standalone MCP server

For an MCP client outside the extension, install Node.js 20 or later and the packaged npm archive:

```sh
npm install -g ./markdown-chroma-0.1.0.tgz
markdown-chroma --help
```

The archive installs both `markdown-chroma` and `markdown-chroma-mcp`. Configure your MCP client to launch a **stdio** server with:

- Command: `markdown-chroma-mcp`
- Arguments: `--root`, `/absolute/path/to/notes`

The equivalent command is `markdown-chroma mcp --root /absolute/path/to/notes`. With the default stdio transport, the client starts the process and communicates over stdin/stdout.

For manual setup in VS Code, run `MCP: Open User Configuration` and add this entry to the configuration's `servers` object:

```json
{
  "servers": {
    "markdown-chroma": {
      "type": "stdio",
      "command": "markdown-chroma-mcp",
      "args": ["--root", "/absolute/path/to/notes"]
    }
  }
}
```

Replace the notes path with your folder. If the client cannot find the executable, replace `command` with its absolute installed path; on macOS/Linux, find it with `command -v markdown-chroma-mcp`. Other clients may use a different configuration format; use the same command and arguments in their stdio server settings. See [VS Code's MCP configuration guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers) for its configuration options.

Run `MCP: List Servers`, select `markdown-chroma`, and start it to verify the manual connection. If you use manual setup alongside the extension, set `markdownChroma.mcp.enabled` to `false` for that workspace folder to avoid offering two servers for the same notes.

### Connect by URL with Streamable HTTP

Start the standalone server in a terminal or service manager:

```sh
markdown-chroma-mcp --transport http --root /absolute/path/to/notes --port 3000
```

Connect your MCP client to `http://127.0.0.1:3000/mcp` using **Streamable HTTP**. The terminal process must keep running. The server prints its URL and resolved project root to stderr. The default bind address is `127.0.0.1`; `--port 0` selects an available port.

For example, add this to VS Code's MCP user configuration:

```json
{
  "servers": {
    "markdown-chroma-http": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

To require authentication, set `MARKDOWN_CHROMA_MCP_TOKEN` in the server's environment and configure the client to send `Authorization: Bearer <token>`. Non-loopback binding with `--host` requires this token and explicit `--allowed-hosts` (comma-separated hostnames or IPs without ports). A reverse proxy can keep the backend on loopback; add the proxy's public hostname to `--allowed-hosts`, set the token, and use HTTPS for the public endpoint. Present `Origin` headers are checked against loopback hostnames by default; `--allowed-origins` sets the permitted origin hostnames. The server provides shared-token authentication; TLS termination and OAuth are handled outside it.

### Project root and automatic indexing

All connection methods query saved files and persist the index on disk. **`--root` is optional**: it defaults to the server process's working directory, and relative paths are resolved there. Specify an absolute root in client or service configurations so the selected project is unambiguous. Each process serves one fixed root; client requests cannot select or change it. Run another process on a different port for another HTTP root.

MCP servers watch the root automatically using the same refresh core as `markdown-chroma watch`. Pass `--no-watch` to disable background watching; queries still refresh saved-file snapshots. VS Code's automatic provider continues to launch stdio servers and supplies the configured workspace root. Begin with `list_sections`, `list_terms`, or `list_glossaries`, then read the selected IDs.

See the [MCP guide](docs/MCP.md) for launch configuration, tool arguments, partial results, and shared API examples.

## Preview scope

- The extension enhances VS Code's built-in reading preview. It does not provide Obsidian Live Preview inside the editor.
- Checkboxes are read-only, and tags are displayed without preview search actions.
- Attachments that need a separate viewer, such as PDF and Canvas files, appear as file links.
- Dataview, Templater, Bases, and search queries are not executed. Obsidian themes and CSS snippets are not loaded automatically. Ordinary code blocks use the existing renderer.
- Local Markdown files on desktop VS Code are supported. Virtual file systems and web extensions are not supported.
- Notes have a 2 MiB read limit. Each preview allows up to 100 embeds and 4 MiB of embedded content. Cycles stop with a visible explanation.
- HTML follows the built-in Markdown renderer and VS Code's security settings.

## References

- [Obsidian Flavored Markdown](https://obsidian.md/help/obsidian-flavored-markdown)
- [Basic syntax](https://obsidian.md/help/syntax), [internal links](https://obsidian.md/help/links), [embeds](https://obsidian.md/help/embeds), [callouts](https://obsidian.md/help/callouts), and [properties](https://obsidian.md/help/properties)
