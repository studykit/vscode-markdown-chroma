import { isIP } from 'node:net';
import { IndexService, errorRecord } from '../index/query';
import { IndexError } from '../index/types';
import { startStdio } from './stdio';
import { startHttp } from './http';
import { startIndexWatch } from '../index/watch';

const help = `Usage: markdown-chroma mcp [options]
Serves saved Markdown/MyST over MCP stdio (default) or Streamable HTTP. Node >=20.

  --root directory          Saved-file project root (default: cwd; fixed at launch)
  --cache-dir directory     Persistent index cache directory
  --transport stdio|http    Connection transport (default: stdio)
  --host address            HTTP bind IP or localhost (default: 127.0.0.1)
  --port number             HTTP port (default: 3000; 0 selects an available port)
  --allowed-hosts names     Comma-separated HTTP Host hostnames, without ports
  --allowed-origins names   Comma-separated Origin hostnames, without scheme/ports
  --no-watch                Disable background file watching (queries still refresh)

HTTP endpoint: /mcp. Startup URL and root are written to stderr.
MARKDOWN_CHROMA_MCP_TOKEN sets a Bearer token; required for non-loopback access.
HTTP options require --transport http. VS Code's automatic provider uses stdio.
`;
const loopback = (host: string) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
const hostnames = (value: string | undefined) => {
  if (value === undefined) return ['localhost', '127.0.0.1', '[::1]'];
  const names = value.split(',').map(name => name.trim().toLowerCase());
  if (names.some(name => !name || (!isIP(name.replace(/^\[|\]$/g, '')) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name)))) {
    throw new IndexError('invalidArguments', 'Allowed hosts/origins must be hostnames without scheme, port or wildcards.');
  }
  return [...new Set(names)];
};

export async function runMcp(argv: string[]): Promise<void> {
  const report = (error: unknown) => { const record = errorRecord(error); process.stderr.write(`${record.code}: ${record.message}\n`); };
  let watcher: Awaited<ReturnType<typeof startIndexWatch>> | undefined;
  try {
    if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(help); return; }
    const values = new Map<string, string>();
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--no-watch' && !values.has('no-watch')) { values.set('no-watch', 'true'); continue; }
      const match = /^--(root|cache-dir|transport|host|port|allowed-hosts|allowed-origins)(?:=(.*))?$/.exec(argv[i]);
      if (!match || values.has(match[1])) throw new IndexError('invalidArguments', `Unknown or repeated option: ${argv[i]}`);
      const value = match[2] ?? argv[++i];
      if (!value || value.startsWith('--')) throw new IndexError('invalidArguments', `Missing value for --${match[1]}.`);
      values.set(match[1], value);
    }
    const transport = values.get('transport') ?? 'stdio';
    if (!['stdio', 'http'].includes(transport)) throw new IndexError('invalidArguments', 'Transport must be stdio or http.');
    if (transport === 'stdio' && ['host', 'port', 'allowed-hosts', 'allowed-origins'].some(name => values.has(name))) {
      throw new IndexError('invalidArguments', 'HTTP options require --transport http.');
    }
    const host = values.get('host') ?? '127.0.0.1';
    if (host !== 'localhost' && !isIP(host)) throw new IndexError('invalidArguments', '--host must be an IP address or localhost.');
    const portValue = values.get('port') ?? '3000', port = Number(portValue);
    if (!/^\d+$/.test(portValue) || !Number.isSafeInteger(port) || port > 65535) throw new IndexError('invalidArguments', '--port must be an integer from 0 to 65535.');
    const allowedHosts = hostnames(values.get('allowed-hosts'));
    const allowedOrigins = hostnames(values.get('allowed-origins'));
    const token = transport === 'http' ? process.env.MARKDOWN_CHROMA_MCP_TOKEN : undefined;
    if (token !== undefined && !/^[\x21-\x7E]+$/.test(token)) throw new IndexError('invalidArguments', 'MARKDOWN_CHROMA_MCP_TOKEN must be a nonempty token without spaces.');
    if (transport === 'http' && (!loopback(host) || [...allowedHosts, ...allowedOrigins].some(name => !loopback(name))) && !token) {
      throw new IndexError('invalidArguments', 'Non-loopback HTTP access requires MARKDOWN_CHROMA_MCP_TOKEN.');
    }
    if (transport === 'http' && !loopback(host) && !values.has('allowed-hosts')) {
      throw new IndexError('invalidArguments', 'Non-loopback HTTP binding requires --allowed-hosts.');
    }
    // Validate and bind one saved-file root before either transport starts.
    const service = new IndexService(values.get('root'), values.get('cache-dir'));
    if (!values.has('no-watch')) watcher = await startIndexWatch(service, { onError: report });
    const handle = transport === 'stdio' ? startStdio(service, report)
      : await startHttp(service, { host, port, allowedHosts, allowedOrigins, token }, report);
    if ('url' in handle) process.stderr.write(`Markdown Chroma MCP listening at ${handle.url}\nRoot: ${service.root}\n`);
    const close = () => { void Promise.all([watcher?.close(), handle.close()]).catch(report); };
    // The SDK closes stdio on EOF; also release background watches and timers.
    if (transport === 'stdio') process.stdin.once('end', () => { void watcher?.close().catch(report); });
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  } catch (error) {
    await watcher?.close();
    report(error);
    process.exitCode = errorRecord(error).code === 'invalidArguments' ? 2 : 1;
  }
}
