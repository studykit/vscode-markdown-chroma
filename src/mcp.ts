#!/usr/bin/env node
import { runMcp } from './mcp/stdio';
runMcp(process.argv.slice(2));
