import { IndexService, errorRecord } from './query';
import { IndexError } from './types';
import { startIndexWatch } from './watch';

export async function runWatch(argv: string[]): Promise<void> {
  const report = (error: unknown) => { const record = errorRecord(error); process.stderr.write(`${record.code}: ${record.message}\n`); };
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write('Usage: markdown-chroma watch [--root directory] [--cache-dir directory] [--debounce-ms 300] [--poll-interval-ms 30000]\nIndexes saved files initially and on changes. Default root: cwd. Emits JSON Lines when the snapshot changes. Stop with Ctrl+C.\n'); return;
    }
    const values = new Map<string, string>();
    for (let i = 0; i < argv.length; i++) {
      const match = /^--(root|cache-dir|debounce-ms|poll-interval-ms)(?:=(.*))?$/.exec(argv[i]);
      if (!match || values.has(match[1])) throw new IndexError('invalidArguments', `Unknown or repeated option: ${argv[i]}`);
      const value = match[2] ?? argv[++i];
      if (!value || value.startsWith('--')) throw new IndexError('invalidArguments', `Missing value for --${match[1]}.`);
      values.set(match[1], value);
    }
    const interval = (name: string) => {
      const value = values.get(name);
      if (value !== undefined && !/^\d+$/.test(value)) throw new IndexError('invalidArguments', `--${name} must be a positive integer.`);
      return value === undefined ? undefined : Number(value);
    };
    const handle = await startIndexWatch(new IndexService(values.get('root'), values.get('cache-dir')), {
      debounceMs: interval('debounce-ms'), pollIntervalMs: interval('poll-interval-ms'), onError: report,
      onRefresh: result => { process.stdout.write(JSON.stringify({ event: 'indexed', ...result }) + '\n'); },
    });
    const close = () => { void handle.close().catch(report); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  } catch (error) { report(error); process.exitCode = errorRecord(error).code === 'invalidArguments' ? 2 : 1; }
}
