import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { IndexService, errorRecord } from '../index/query';
import { IndexError } from '../index/types';
import { createMarkdownMcpServer } from './server';

export function runMcp(argv: string[]): void {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write('Usage: markdown-chroma mcp [--root directory] [--cache-dir directory]\nServes saved Markdown/MyST over MCP stdio. Node >=20. Default root: cwd.\n');
      return;
    }
    const values = new Map<string, string>();
    for (let i = 0; i < argv.length; i++) {
      const match = /^--(root|cache-dir)(?:=(.*))?$/.exec(argv[i]);
      if (!match || values.has(match[1])) throw new IndexError('invalidArguments', `Unknown or repeated option: ${argv[i]}`);
      const value = match[2] ?? argv[++i];
      if (!value || value.startsWith('--')) throw new IndexError('invalidArguments', `Missing value for --${match[1]}.`);
      values.set(match[1], value);
    }
    // Validate the root before listening, so invalid launches fail without protocol output.
    const service = new IndexService(values.get('root'), values.get('cache-dir'));
    const report = (error: unknown) => { const record = errorRecord(error); process.stderr.write(`${record.code}: ${record.message}\n`); };
    const handle = serveStdio(() => createMarkdownMcpServer(service), { onerror: report });
    const close = () => { void handle.close().catch(report); };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  } catch (error) {
    const record = errorRecord(error);
    process.stderr.write(`${record.code}: ${record.message}\n`);
    process.exitCode = record.code === 'invalidArguments' ? 2 : 1;
  }
}
