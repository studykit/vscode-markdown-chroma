#!/usr/bin/env node
import { runCli } from './index/cli';
import { runMcp } from './mcp/cli';
import { runWatch } from './index/watch-cli';

const args = process.argv.slice(2);
if (args[0] === 'mcp') void runMcp(args.slice(1));
else if (args[0] === 'watch') void runWatch(args.slice(1));
else void runCli(args).then(code => { process.exitCode = code; });
