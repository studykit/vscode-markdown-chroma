# Markdown Chroma MCP server

Give an MCP client access to a folder of saved Markdown/MyST files. The server provides the same search and retrieval features as the [CLI](CLI.md), through **13 tools**, with stdio or Streamable HTTP connections.

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

Multi-root workspaces offer one server for each trusted local folder. Roots outside the workspace or missing directories are rejected. Definitions are refreshed when folders, settings, or trust change and are checked again before launch. The preview's `obsidianMarkdown.vaultRoot` setting is separate.

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

Both stdio and HTTP watch saved files by default. Events are grouped over 300 ms, then the existing refresh checks the whole file list and hashes and reparses only changed documents. A full scan every 30 seconds covers missed events and replaced directories. Pass `--no-watch` to disable background watching; queries still refresh saved-file snapshots.

Watch covers Markdown, MyST configuration, bibliography, and attachment changes. Hidden paths, `node_modules`, `_build`, symlinks, and the root's cache directory are excluded. SIGINT/SIGTERM stops both watcher and transport. The [CLI watch command](CLI.md#keep-the-index-up-to-date) uses the same core and can run independently.

## Tools

File arguments are exact paths relative to the server root. Optional arguments may be omitted; bold arguments are required.

| Tool | Arguments | Result |
| --- | --- | --- |
| `index_documents` | `rebuild` | Refresh/rebuild the cache and return statistics |
| `list_notes` | `unresolved` | Documents, tags, properties, references, and item counts |
| `search_notes` | `tags`, `exactTag`, `where`, `hasProperty` | AND search; at least one tag/property filter is required |
| `get_backlinks` | **`file`**, `term` | Incoming references to a document or term |
| `list_sections` | **`file`** | Section hierarchy, IDs, labels, and source hash |
| `read_section` | **`file`**, **`id` or `label`**, `includeChildren`, `sourceHash` | Original Markdown, including child sections by default |
| `list_tables` | `file`, `section` | Table captions, headers, dimensions, and locations |
| `list_images` | `file`, `section` | Image sources, alt text, figure metadata, and locations |
| `list_glossaries` | `file` | Glossaries across the root or in one file |
| `list_terms` | `file`, `glossary`, `name` | Term definitions across the root or in a narrower scope |
| `read_terms` | **`names` or `ids`**, `file`, `sourceHash` | Multiple selected definitions; `file` applies only to name selection |
| `read_glossaries` | **`ids`** | Original Markdown for selected glossaries |
| `read_items` | **`ids`** | A mix of selected terms and glossaries |

A `section` filter also requires `file`. `where` is a JSON object with string, number, boolean, or null values; array properties match members. Tags include descendants by default.

List sections or glossary/term items first, then read IDs returned by those responses. Do not infer source line ranges. Use `sourceHash` when the read must match a previous listing.

## Results and saved-file behavior

Results include `schemaVersion: 1`, `complete`, and command-specific data. MCP returns both `structuredContent` and JSON text `content`. Partial results use `complete: false` and `isError: true`, preserving successful items alongside diagnostics or per-item errors. SDK input validation errors may have text content without `structuredContent`.

Ambiguous term names return `ambiguousTerm` with candidates; choose a file or a global ID. Batch selections preserve request order and deduplicate identical selections. Selecting a glossary and one of its terms returns both.

Queries use saved files. They do not read unsaved editor contents. Requests and background refreshes are serialized on the same service; separate CLI/server processes share cache locks. Cancellation can stop a lock wait but does not interrupt synchronous parsing already in progress. Full scan cost grows with the root size; pagination is not provided.

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
