import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createMcpHandler, validateHostHeader, validateOriginHeader } from '@modelcontextprotocol/server';
import type { IndexService } from '../index/query';
import { createMarkdownMcpServer } from './server';

export interface HttpOptions {
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  token?: string;
}

/** Adapt Node streams to the SDK's public, stateless web-standard HTTP handler. */
export async function startHttp(service: IndexService, options: HttpOptions, report: (error: unknown) => void) {
  const handler = createMcpHandler(() => createMarkdownMcpServer(service), {
    maxRequestBodySize: 2 * 1024 * 1024, onerror: report,
  });
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = options.token ? digest(`Bearer ${options.token}`) : undefined;
  const server = createServer((req, res) => {
    const respond = (status: number, message: string) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    };
    // Check headers before constructing a URL or consuming an untrusted body.
    if (!validateHostHeader(req.headers.host, options.allowedHosts).ok ||
        !validateOriginHeader(req.headers.origin, options.allowedOrigins).ok) {
      respond(403, 'Host or Origin is not allowed.'); return;
    }
    if (expected && !timingSafeEqual(expected, digest(req.headers.authorization ?? ''))) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      respond(401, 'Bearer token required.'); return;
    }
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://${req.headers.host}`); }
    catch { respond(400, 'Invalid request URL.'); return; }
    if (url.pathname !== '/mcp') { respond(404, 'MCP endpoint is /mcp.'); return; }
    if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
      res.setHeader('Allow', 'POST, GET, DELETE'); respond(405, 'Method not allowed.'); return;
    }
    const abort = new AbortController();
    const disconnected = () => { if (!res.writableEnded) abort.abort(); };
    req.once('aborted', disconnected);
    res.once('close', disconnected);
    void (async () => {
      try {
        const headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
        const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, signal: abort.signal };
        if (req.method === 'POST') { init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>; init.duplex = 'half'; }
        const response = await handler.fetch(new Request(url, init));
        res.statusCode = response.status;
        response.headers.forEach((value, name) => res.setHeader(name, value));
        if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
        else res.end();
      } catch (error) {
        if (abort.signal.aborted) return;
        report(error);
        if (!res.headersSent) respond(500, 'MCP request failed.');
        else res.destroy();
      } finally {
        req.removeListener('aborted', disconnected);
        res.removeListener('close', disconnected);
      }
    })();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) { await handler.close(); throw error; }
  server.on('error', report);
  const address = server.address();
  const hostname = options.host.includes(':') ? `[${options.host}]` : options.host;
  const url = `http://${hostname}:${typeof address === 'object' && address ? address.port : options.port}/mcp`;
  let closing: Promise<void> | undefined;
  return { url, close: () => closing ??= (async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try { await handler.close(); } finally { server.closeAllConnections(); }
    await closed;
  })() };
}
