#!/usr/bin/env node
import { runCli } from './index/cli';

void runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
