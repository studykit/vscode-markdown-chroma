# Markdown Chroma MCP server

Give an MCP client access to a folder of saved Markdown/MyST files. The server provides the same search and retrieval features as the [CLI](CLI.md), through **15 tools**, with stdio or Streamable HTTP connections.

[Back to the overview](../README.md) · [CLI guide](CLI.md) · [Detailed index specification](CLI-INDEX-SPEC.md)

## Use the server included in the VS Code extension

1. Install Markdown Chroma and open a trusted local folder containing Markdown files.
2. Open a Markdown file to activate the extension.
3. Run **MCP: List Servers** from the Command Palette.
4. Select **Markdown Chroma: <folder name>** and start the server. Confirm server trust when prompted.

VS Code manages the server process and tool approvals. The bundled server uses the VS Code host runtime, so you do not need a separate Node.js or npm installation. This requires a host with the MCP provider API; older hosts retain preview support.

| Setting | Default | Behavior |
| --- | --- | --- |
| `markdownChroma.mcp.enabled` | `true` | Offer an MCP server for the workspace folder |
| `markdownChroma.mcp.root` | `""` | Use the workspace folder; set a relative path or an absolute directory inside it to narrow the root |

Multi-root workspaces offer one server for each trusted local folder. Roots outside the workspace or missing directories are rejected. Definitions are refreshed when folders, settings, or trust change and are checked again before launch. The preview's `markdownChroma.preview.root` setting is separate.

If a server is missing, check these settings and the **Markdown Chroma MCP** output channel.

## Install a standalone server

For clients outside the extension, install Node.js 20 or later and the packaged npm archive:

```sh
npm install -g ./markdown-chroma-0.1.0.tgz
markdown-chroma-mcp --help
```

The archive installs both `markdown-chroma` and `markdown-chroma-mcp`. The following commands run the same server:

```sh
markdown-chroma-mcp --root /absolute/path/to/notes
markdown-chroma mcp --root /absolute/path/to/notes
```

For a build from source, use `node dist/mcp.cjs` with the same options. See [developer setup](../AGENTS.md).

## Connect over stdio

Configure your MCP client to launch:

- **Command:** `markdown-chroma-mcp`
- **Arguments:** `--root`, `/absolute/path/to/notes`

Stdio is the default. The client starts the process and communicates through stdin/stdout; it does not open a network port. stdout is reserved for MCP protocol messages, and errors go to stderr. stdin EOF or SIGINT/SIGTERM closes the transport and watcher.

In VS Code, run **MCP: Open User Configuration** and add this to the `servers` object:

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

Replace the root with your folder. If the client cannot find the executable, use its absolute installed path; on macOS/Linux, find it with `command -v markdown-chroma-mcp`. Other clients may use a different configuration format with the same command and arguments.

Run **MCP: List Servers**, select the server, and start it. If you use manual setup alongside the extension, set `markdownChroma.mcp.enabled` to `false` for that workspace folder to avoid two servers for the same project. See [VS Code's MCP configuration guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

## Connect by URL with Streamable HTTP

Start the server in a terminal or service manager:

```sh
markdown-chroma-mcp --transport http --root /absolute/path/to/notes --port 3000
```

Connect to **`http://127.0.0.1:3000/mcp`** with your client's Streamable HTTP transport. Keep the server process running. It prints the listening URL and resolved root to stderr, while stdout remains empty.

For VS Code, add this to the MCP user configuration:

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

`--host` sets the bind IP or `localhost` and defaults to `127.0.0.1`. `--port` defaults to `3000`; `--port 0` chooses an available port.

HTTP uses the same root-bound index service as stdio. The SDK's public `createMcpHandler` creates an MCP instance for each request and shares the index service and cache. Both the SDK's current protocol and 2025 `initialize` flows are supported. The 2025 flow is stateless with no session ID; there is no separate `/sse` endpoint or legacy HTTP+SSE transport. Request bodies are limited to 2 MiB.

### Authentication and external access

Set `MARKDOWN_CHROMA_MCP_TOKEN` in the server environment to require `Authorization: Bearer <token>` on HTTP requests. Tokens must be nonempty printable ASCII without spaces, and are not passed through URLs, command arguments, or logs.

Non-loopback binding or non-loopback allowed hostnames/origins requires the token. Non-loopback binding also requires explicit `--allowed-hosts`. For example, with the token already supplied through your service environment or secret store:

```sh
markdown-chroma-mcp --transport http --root /absolute/path/to/notes \
  --host 0.0.0.0 --port 3000 --allowed-hosts notes.example.com,192.168.1.10
```

`Host` and present `Origin` headers are checked. By default, only loopback hostnames are allowed; requests without an `Origin` header are accepted. `--allowed-hosts` and `--allowed-origins` take comma-separated hostnames/IPs without schemes, ports, or wildcards. Use brackets for IPv6 hostnames, such as `[::1]`.

For a public endpoint, use HTTPS through a reverse proxy. The backend can stay on loopback, but the forwarded Host must be allowed and the token supplied. The server uses one shared Bearer token, with no per-user roots or permissions. TLS termination and OAuth are handled outside it.

## Choose the project root

**`--root` is optional.** It defaults to the server process's starting directory. Relative paths are resolved there, rather than on the client's machine. Absolute roots are recommended in client and service configuration.

The root must be an existing directory and stays fixed for the lifetime of the process. Requests cannot select another root or escape it. Neither `.obsidian` nor MyST configuration changes the root. To serve another project over HTTP, run another process on a different port.

## Automatic indexing

Both stdio and HTTP watch saved files by default. Events are grouped over 300 ms, then the existing refresh checks the whole file list and hashes and reparses only changed documents. A full scan every 30 seconds covers missed events and replaced directories. Pass `--no-watch` to disable background watching; structural queries still refresh saved-file snapshots; line reads access saved source directly.

Watch covers Markdown, MyST configuration, local plugin definitions, bibliography, and attachment changes. Hidden paths, `node_modules`, `_build`, symlinks, and the root's cache directory are excluded. SIGINT/SIGTERM stops both watcher and transport. The [CLI watch command](CLI.md#keep-the-index-up-to-date) uses the same core and can run independently.

## Tools

File arguments are exact paths relative to the server root. Optional arguments may be omitted; bold arguments are required.

| Tool | Arguments | Result |
| --- | --- | --- |
| `index_documents` | `rebuild` | Refresh available documents and return their count |
| `list_notes` | `unresolved` | Files and titles |
| `search_notes` | `tags`, `exactTag`, `where`, `hasProperty` | AND search; at least one tag/property filter is required |
| `get_backlinks` | **`file`**, `term` | Incoming references to a document or term |
| `list_sections` | **`file`** | A tree of section titles |
| `read_section` | **`file`**, **one of `title`, `headingPath`, `id`, `label`, or `line`**, `includeChildren`, `sourceHash` | Original Markdown, including child sections by default |
| `read_lines` | **`file`**, **`startLine`**, `endLine`, `sourceHash` | Exact source range; default 20 lines, clamped at EOF; no index refresh |
| `read_frontmatter` | **`file`**, `sourceHash` | Original YAML including delimiters; empty content when absent |
| `list_tables` | `file`, `section` | Captions, headers, and owning heading paths |
| `list_images` | `file`, `section` | Sources, alt text, captions, and owning heading paths |
| `list_glossaries` | `file` | Glossary choices and term counts |
| `list_terms` | `file`, `glossary`, `name` | Term names, files, and IDs for reading |
| `read_terms` | **`names` or `ids`**, `file`, `sourceHash` | Multiple selected definitions; `file` applies only to name selection |
| `read_glossaries` | **`ids` or `file` with `title` or `headingPath`** | Original Markdown for selected glossaries; titles select the owning section |
| `read_items` | **`selections` or `ids`**, `maxChars` | Budgeted sections/terms by natural names, or legacy term/glossary IDs |

A `section` filter also requires `file`. `where` is a JSON object with string, number, boolean, or null values; array properties match members. Tags include descendants by default.

Use external shell tools such as grep/rg for source string search. The server provides indexed metadata, structural selection and saved-source reads. Pass an observed file/line location to `read_lines({file,startLine,endLine})` for a small source range or `read_section({file,line})` for its owning section.

Line reads default to 20 lines, clamp at EOF, preserve line endings, and reject starts past EOF. They access validated saved source directly without parsing or refreshing the index; malformed YAML/MyST does not prevent a raw line read. Root, cache/traversal exclusions, symlink, UTF-8 and size checks remain in force. Structural tools retain their normal index refresh and completeness behavior.

List sections first, then read an exact, case-sensitive `title`. Duplicate titles return candidate full heading paths; pass one as `headingPath: ["Parent", "Child"]`. If the path is also duplicated, candidates include IDs for explicit selection. IDs and MyST labels remain supported. Read a glossary by its file and owning section title or path, or use listed IDs for batch selections and indistinguishable glossaries. Term reads use names or listed IDs. Do not infer source line ranges. A titleless `[preamble]` item can be read with `id: "preamble"`.

### Batch source reads

Use `read_items` after discovering the needed files and names, reducing separate read calls:

```json
{
  "selections": [
    {"kind": "section", "file": "guide.md", "title": "Installation"},
    {"kind": "section", "file": "guide.md", "headingPath": ["Installation", "macOS"]},
    {"kind": "term", "file": "glossary.md", "name": "AST"}
  ],
  "maxChars": 12000
}
```

Accept 1–100 selections. A section requires `file` and exactly one of `title`, `headingPath`, `id`, `label`, or an observed `line`. It returns its own body by default; `includeChildren: true` includes descendants. This default is specific to batch reads; `read_section` still includes children by default. A term requires `name` and optionally `file` to disambiguate definitions. Each selection can supply `sourceHash` when a previous Node/debug snapshot must match.

Repeated selections are removed. Overlapping ranges in a file return original source once, positioned at the first contributing selection, with `covers` listing the other names included. Separate ranges preserve request order. No generated summaries replace source.

`maxChars` defaults to 12,000 and accepts 1–200,000. It counts Unicode characters in returned source, not model tokens or response metadata. Omit a whole merged range if it cannot fit, then try later ranges. An omitted item has `omitted: true`, `reason: "budget"`, and `requiredChars`; the response includes `budget: {maxChars, usedChars}`. Retry a smaller selection or increase the budget. A merged parent/child range is omitted together; retry just the child if needed.

Omissions and selection errors return `complete: false` and `isError: true` while preserving successful content. If all selections include `file`, unrelated document issues are excluded. A name-only term selection retains project-wide completeness. Successful batches omit budget metadata from concise responses. Node/debug responses retain ranges, hashes, statuses, and the budget.

The existing `ids` mode reads terms and glossaries, deduplicates IDs, and preserves overlapping item content. It cannot be combined with `selections` or `maxChars`.

## Results and saved-file behavior

Results contain retrieval information and `complete`. They omit cache paths, versions, hashes, parser ranges and records. Observed shell-search line numbers may be supplied to read tools. MCP returns the same concise result as `structuredContent` and JSON text `content`. Partial results use `complete: false` and `isError: true`, preserving successful items alongside `issues` or per-item errors. SDK input validation errors may have text content without `structuredContent`.

`issues` contains one short summary of relevant problems. File queries and section or explicit-item reads exclude unrelated document or source-range syntax diagnostics. File-wide frontmatter/configuration problems remain relevant. Global discovery, name-only term lookup, and backlinks retain project-wide completeness, as parsing failures can hide matches. Per-item errors and budget omissions always make a batch partial. The Node API and CLI `--debug` retain all snapshot diagnostics and project-wide status.

Both transports share [MyST plugin inspection](CLI.md#myst-project-plugins): confirmed static local role/directive declarations do not produce unknown-syntax errors, and plugin code is never executed. Discovery reports `complete: false` and `isError: true` when generated content may be missing. Explicit saved-source reads ignore this generation limitation, while name-only term selection remains conservative. Uninspectable definitions and real syntax errors retain their diagnostics. Source content is never rewritten.

For example, `list_sections` returns:

```json
{
  "complete": true,
  "file": "guide.md",
  "sections": [
    { "title": "Installation", "children": [{ "title": "macOS" }] }
  ]
}
```

Read a listed title with `read_section({"file":"guide.md","title":"macOS"})`. A successful read returns the file and original Markdown `content`. Term/glossary batch reads return each item's kind, file, name when available, and content. Ambiguous reads provide concise `candidates` for explicit selection. CLI `--json` uses this same retrieval format. Full records remain available through the Node API and CLI `--debug`; MCP does not return them.

Ambiguous term names return `ambiguousTerm` with candidates; choose a file or a global ID. Batch selections preserve request order and deduplicate identical selections. Selecting a glossary and one of its terms returns both.

Queries use saved files. They do not read unsaved editor contents. Requests and background refreshes are serialized on the same service; structural queries in separate CLI/server processes share cache locks. Line reads do not acquire those locks. Cancellation can stop a lock wait but does not interrupt synchronous parsing already in progress. Structural refresh cost grows with the root size. Structural lists do not provide pagination.

Read tools return original Markdown. Tables and images provide lists and locations, rather than separate raw-content reads or image binaries. See the [index specification](CLI-INDEX-SPEC.md) for other limits and diagnostics.

## Shared Node API

`markdown-chroma/index` exports the same `IndexService`, plus TypeScript declarations:

```js
const { IndexService } = require('markdown-chroma/index');
const service = new IndexService('/absolute/path/to/notes');
const sections = await service.execute({
  command: 'sections', arguments: { file: 'guide.md' }
});
const selected = sections.sections[0];
if (selected) {
  const result = await service.execute({
    command: 'read-section',
    arguments: { file: 'guide.md', id: selected.id, sourceHash: sections.sourceHash }
  });
  console.log(result.content);
}
```

`IndexQuery`, `QueryArguments`, and `querySchemas` describe command inputs. `execute(query, { signal })` accepts cancellation. The library itself does not print to stdout/stderr.

The shared watcher API releases watches and timers and cancels pending cache lock waits when closed:

```js
const { IndexService, startIndexWatch } = require('markdown-chroma/index');
const service = new IndexService('/absolute/path/to/notes');
const watcher = await startIndexWatch(service, {
  debounceMs: 300,
  pollIntervalMs: 30000,
  onRefresh: result => console.log(result.generation),
  onError: error => console.error(error)
});
// Call during your application's shutdown.
await watcher.close();
```

## References

- [VS Code MCP extension API](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [Official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
