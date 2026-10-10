#!/usr/bin/env node
import { runCli } from './index/cli';
import { runMcp } from './mcp/stdio';

const args = process.argv.slice(2);
if (args[0] === 'mcp') runMcp(args.slice(1));
else void runCli(args).then(code => { process.exitCode = code; });
