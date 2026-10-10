import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { IndexService } from '../index/query';
import { createMarkdownMcpServer } from './server';

export function startStdio(service: IndexService, report: (error: unknown) => void) {
  return serveStdio(() => createMarkdownMcpServer(service), { onerror: report });
}
