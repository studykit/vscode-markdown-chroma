import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { IndexService } from '../src/index/query';
import { runCli } from '../src/index/cli';
import { presentResult } from '../src/index/presentation';
import { occurrences } from '../src/index/expansion-source';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startHttp } from '../src/mcp/http';
import { assertRetrievalResult } from './retrieval-contract';

async function fixture(files: Record<string, string>) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'chroma-expand-')), root = path.join(directory, 'docs'), cache = path.join(directory, 'cache');
  await fs.mkdir(root);
  const write = async (file: string, source: string) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), source); };
  for (const [file, source] of Object.entries(files)) await write(file, source);
  const service = new IndexService(root, cache, { allowProjectPlugins: true });
  const expand = async (file: string, name: string, options = {}) => {
    const source = await fs.readFile(path.join(root, file), 'utf8'), occurrence = occurrences(source).find(item => item.name === name)!;
    assert.ok(occurrence, name);
    const query = { command: 'expand-directive' as const, arguments: { file, line: occurrence.startLine, ...options } };
    const result = await service.execute(query); assert.ok('expansion' in result); return result;
  };
  const cli = async (...args: string[]) => { let stdout = '', stderr = ''; const code = await runCli([...args, '--root', root, '--cache-dir', cache], { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }); return { code, stdout, stderr }; };
  return { directory, root, cache, service, write, expand, cli, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}
const plugin = `import fs from 'node:fs';
import { greeting } from './helper.mjs';
const record = text => fs.appendFileSync(new URL('../counts.txt', import.meta.url), text + '\\n');
record('load'); console.log('plugin stdout'); console.error('plugin stderr');
export default {directives:[
 {name:'demo:greeting',alias:['demo:hello'],arg:{type:String,required:true},options:{suffix:{type:String,alias:['ending']}},body:{type:'myst'},run(data, file, ctx){record('greeting'); const dataValue=JSON.parse(fs.readFileSync(new URL('./data.json',import.meta.url),'utf8')).value; return [{type:'heading',depth:2,children:[{type:'text',value:greeting+' '+data.arg+(data.options.suffix??'')}]},...(data.body??[]),...ctx.parseMyst('| Column | Value |\\n| --- | --- |\\n| generated | '+dataValue+' |').children];}},
 {name:'demo:outer',body:{type:'myst'},run(data){record('outer');return data.body;}},
 {name:'demo:inner',run(){record('inner');return [{type:'paragraph',children:[{type:'text',value:'INNER_RESULT'}]}];}},
 {name:'demo:unrelated',run(){record('unrelated');throw new Error('UNRELATED_MUST_NOT_RUN');}},
 {name:'demo:fail',run(){record('failure');throw new Error('CALLBACK_FAILURE');}},
 {name:'demo:hang',run(){while(true){};}},
 {name:'demo:unknown-node',run(){return [{type:'customUnsupported',children:[{type:'text',value:'READABLE_CHILD'}]}];}},
 {name:'demo:unicode',run(){return [{type:'paragraph',children:[{type:'text',value:'😀'.repeat(50)}]}];}}
],roles:[{name:'demo:badge',alias:['demo:tag'],body:{type:String},run(data){record('role');return [{type:'strong',children:[{type:'text',value:data.body}]}];}}]};`;
const pluginFiles = { 'myst.yml': 'project:\n  plugins: [./plugin.mjs]\n', 'plugin.mjs': plugin, 'helper.mjs': "export const greeting='Hello';", 'data.json': '{"value":"FIRST"}' };

test('includes, literal filters, local/label/Obsidian embeds use saved source and preserve the source index', async t => {
  const f = await fixture({ ...pluginFiles, 'source.md': '# Source\n\n:::{include} target.md\n:::\n\n:::{literalinclude} code.py\n:start-after: START\n:end-before: END\n:::\n\n:::{embed} #detail-label\n:::\n\n![[target#Detail]]\n',
    'target.md': '(detail-label)=\n# Detail\nTARGET_CONTENT\n\n| A | B |\n| - | - |\n| x | y |\n', 'code.py': 'START\nprint("CODE_CONTENT")\nEND\n' }); t.after(f.cleanup);
  assert.match((await f.expand('source.md', 'include')).content, /TARGET_CONTENT/);
  const literal = await f.expand('source.md', 'literalinclude'); assert.equal(literal.complete, true); assert.match(literal.content, /```python\nprint/); assert.ok(!literal.content.includes('START') && !literal.content.includes('END'));
  assert.match((await f.expand('source.md', 'embed')).content, /TARGET_CONTENT/);
  assert.match((await f.expand('source.md', 'obsidian-embed')).content, /TARGET_CONTENT/);
  await assert.rejects(fs.readFile(path.join(f.directory, 'counts.txt')), { code: 'ENOENT' });
  const tables = await f.service.execute({ command: 'tables', arguments: { file: 'source.md' } }); assert.ok('tables' in tables); assert.equal(tables.tables.length, 0);
  const source = await f.service.execute({ command: 'read-section', arguments: { file: 'source.md', title: 'Source' } }); assert.ok('content' in source); assert.ok(!source.content.includes('TARGET_CONTENT'));
});

test('one custom directive uses aliases, options, roles and readable AST; other callbacks never execute', async t => {
  const f = await fixture({ ...pluginFiles, 'guide.md': '# Guide\n\n:::{demo:greeting} reader\n:suffix: !\n\nBody {demo:badge}`important`.\n:::\n\n:::{demo:hello} reader\n:ending: !\n\nBody {demo:tag}`important`.\n:::\n\n:::{demo:unrelated}\n:::\n' }); t.after(f.cleanup);
  await f.service.execute({ command: 'index', arguments: {} });
  await f.service.execute({ command: 'read-section', arguments: { file: 'guide.md', title: 'Guide' } });
  await assert.rejects(fs.readFile(path.join(f.directory, 'counts.txt')), { code: 'ENOENT' });
  const canonical = await f.expand('guide.md', 'demo:greeting'), alias = await f.expand('guide.md', 'demo:hello');
  assert.equal(canonical.complete, true, JSON.stringify(canonical.diagnostics)); assert.equal(alias.complete, true, JSON.stringify(alias.diagnostics)); assert.equal(canonical.content, alias.content);
  assert.match(canonical.content, /## Hello reader!/); assert.match(canonical.content, /\*\*important\*\*/); assert.match(canonical.content, /generated \| FIRST/);
  assert.match(canonical.logs, /plugin stdout/); assert.match(canonical.logs, /plugin stderr/);
  assert.deepEqual((await fs.readFile(path.join(f.directory, 'counts.txt'), 'utf8')).trim().split('\n'), ['load','role','greeting','load','role','greeting']);
  const choice = occurrences(await fs.readFile(path.join(f.root, 'guide.md'), 'utf8'))[0];
  const cli = await f.cli('expand-directive', 'guide.md', '--line', String(choice.startLine), '--allow-project-plugins', '--json');
  assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).content, canonical.content); assertRetrievalResult(JSON.parse(cli.stdout));
  await f.write('helper.mjs', "export const greeting='Saved';"); await f.write('data.json', '{"value":"SECOND"}');
  const changed = await f.expand('guide.md', 'demo:greeting'); assert.match(changed.content, /Saved reader/); assert.match(changed.content, /SECOND/);
});

test('nested directive callbacks obey depth before executing and keep original syntax at the limit', async t => {
  const f = await fixture({ ...pluginFiles, 'guide.md': '# Guide\n\n::::{demo:outer}\nBefore.\n:::{demo:inner}\n:::\nAfter.\n::::\n\n:::{demo:unrelated}\n:::\n' }); t.after(f.cleanup);
  const shallow = await f.expand('guide.md', 'demo:outer'); assert.equal(shallow.complete, false); assert.match(shallow.content, /demo:inner/); assert.match(shallow.content, /Before/); assert.ok(!shallow.content.includes('INNER_RESULT'));
  assert.deepEqual((await fs.readFile(path.join(f.directory,'counts.txt'),'utf8')).trim().split('\n'), ['load','outer']);
  const deep = await f.expand('guide.md', 'demo:outer', { maxDepth: 2 }); assert.equal(deep.complete, true, JSON.stringify(deep.diagnostics)); assert.match(deep.content, /INNER_RESULT/);
  assert.deepEqual((await fs.readFile(path.join(f.directory,'counts.txt'),'utf8')).trim().split('\n'), ['load','outer','load','inner','outer']);
});

test('nested includes stop cycles/depth, respect UTF-8 budgets, and report unsupported targets', async t => {
  const f = await fixture({ 'a.md': '# A\n\n:::{include} b.md\n:::\n', 'b.md': '# B\n\n:::{include} a.md\n:::\n', 'notebook.md': ':::{embed} note.ipynb#cell\n:::\n', 'note.ipynb': '{}', 'block.md': '![[a#^block]]\n' }); t.after(f.cleanup);
  const shallow = await f.expand('a.md','include'); assert.equal(shallow.complete,false); assert.match(shallow.content,/include/);
  const cycle = await f.expand('a.md','include',{maxDepth:10}); assert.equal(cycle.complete,false); assert.ok(cycle.diagnostics.some(issue=>/Cyclic/.test(issue.message)));
  assert.equal((await f.expand('notebook.md','embed')).complete,false); assert.equal((await f.expand('block.md','obsidian-embed')).complete,false);
  await f.write('b.md','😀'.repeat(30)); const budget=await f.expand('a.md','include',{maxChars:7}); assert.equal(Array.from(budget.content).length,7); assert.equal(budget.content,'😀'.repeat(7)); assert.equal(budget.complete,false);
});

test('selection excludes frontmatter/code and nested inline embeds preserve surrounding text and observed lines', async t => {
  const f = await fixture({ 'guide.md': '---\nexample: |\n  :::{include} hidden.md\n  :::\n---\n\n```md\n:::{include} hidden.md\n:::\n```\n\n:::{include} target.md\n:::\n',
    'target.md': 'First line.\nBefore ![[child]] after.\n', 'child.md': 'CHILD_CONTENT', 'hidden.md': 'MUST_NOT_READ' }); t.after(f.cleanup);
  const items = occurrences(await fs.readFile(path.join(f.root, 'guide.md'), 'utf8')); assert.equal(items.length, 1); assert.equal(items[0].name, 'include');
  const targetItems = occurrences(await fs.readFile(path.join(f.root, 'target.md'), 'utf8')); assert.equal(targetItems[0].startLine, 2);
  const expanded = await f.expand('guide.md', 'include', { maxDepth: 2 }); assert.equal(expanded.complete, true, JSON.stringify(expanded.diagnostics)); assert.match(expanded.content, /Before CHILD_CONTENT after/); assert.match(expanded.content, /First line/);
});

test('configuration inheritance and saved changes are observed, while frontmatter cannot authorize executable modules', async t => {
  const f = await fixture({ 'config/base.yml': 'project:\n  plugins: [./plugin.mjs]\n', 'myst.yml': 'extends: ./config/base.yml\n',
    'config/plugin.mjs': "export default {directives:[{name:'generated',run(){return [{type:'paragraph',children:[{type:'text',value:'CONFIG_FIRST'}]}]}}]};",
    'evil.mjs': "throw new Error('FRONTMATTER_MUST_NOT_LOAD');", 'sub/guide.md': '---\nplugins: [../evil.mjs]\n---\n\n:::{generated}\n:::\n' }); t.after(f.cleanup);
  assert.match((await f.expand('sub/guide.md', 'generated')).content, /CONFIG_FIRST/);
  await f.write('config/other.mjs', "export default {directives:[{name:'generated',run(){return [{type:'paragraph',children:[{type:'text',value:'CONFIG_CHANGED'}]}]}}]};");
  await f.write('config/base.yml', 'project:\n  plugins: [./other.mjs]\n'); const changed = await f.expand('sub/guide.md', 'generated'); assert.equal(changed.complete, true, JSON.stringify(changed.diagnostics)); assert.match(changed.content, /CONFIG_CHANGED/);
  await f.write('sub/guide.md', '---\nplugins: [../evil.mjs]\n---\n\n\n:::{generated}\n:::\n'); assert.match((await f.expand('sub/guide.md', 'generated')).content, /CONFIG_CHANGED/);
});

test('generated include output obeys depth and uses its authored filters', async t => {
  const f=await fixture({'myst.yml':'project:\n  plugins: [./plugin.mjs]\n','plugin.mjs':"export default {directives:[{name:'generated',run(data,file,ctx){return ctx.parseMyst(':::{include} data.md\\n:start-after: START\\n:end-before: END\\n:::').children;}}]};",'guide.md':':::{generated}\n:::\n','data.md':'START\nINCLUDED_FILTERED\nEND\n'}); t.after(f.cleanup);
  const shallow=await f.expand('guide.md','generated'); assert.equal(shallow.complete,false); assert.match(shallow.content,/include/); assert.ok(!shallow.content.includes('INCLUDED_FILTERED'));
  const deep=await f.expand('guide.md','generated',{maxDepth:2}); assert.equal(deep.complete,true,JSON.stringify(deep.diagnostics)); assert.match(deep.content,/INCLUDED_FILTERED/); assert.ok(!deep.content.includes('START') && !deep.content.includes('END'));
});

test('directives selected inside lists and quotes retain authored arguments, options and body', async t => {
  const f=await fixture({...pluginFiles,'guide.md':'- Parent item\n\n    :::{demo:greeting} reader\n    :ending: !\n\n    Authored body.\n    :::\n\n> :::{demo:hello} reader\n> :ending: !\n>\n> Authored body.\n> :::\n'}); t.after(f.cleanup);
  const list=await f.expand('guide.md','demo:greeting'),quote=await f.expand('guide.md','demo:hello');
  assert.equal(list.complete,true,JSON.stringify(list.diagnostics)); assert.equal(quote.complete,true,JSON.stringify(quote.diagnostics));
  assert.equal(list.content,quote.content); assert.match(list.content,/Hello reader!/); assert.match(list.content,/Authored body/);
});

test('disabled capability, invalid/ambiguous selections, stale hashes, root escapes and symlinks are actionable', async t => {
  const f=await fixture({...pluginFiles,'guide.md':':::{demo:inner}\n:::\n\n![[a]] ![[b]]\n','a.md':'# A\n','b.md':'# B\n','escape.md':':::{include} ../outside.md\n:::\n'}); t.after(f.cleanup);
  const disabled=new IndexService(f.root,f.cache);
  await assert.rejects(disabled.execute({command:'expand-directive',arguments:{file:'guide.md',line:1}}),{code:'projectPluginsDisabled'});
  await assert.rejects(disabled.execute({command:'expand-directive',arguments:{file:'guide.md',line:1,allowProjectPlugins:true} as any}),{code:'invalidArguments'});
  await assert.rejects(f.service.execute({command:'expand-directive',arguments:{file:'guide.md',line:2}}),{code:'directiveNotFound'});
  await assert.rejects(f.service.execute({command:'expand-directive',arguments:{file:'guide.md',line:4}}),{code:'ambiguousDirective'});
  await assert.rejects(f.service.execute({command:'expand-directive',arguments:{file:'guide.md',line:1,sourceHash:'sha256:old'}}),{code:'documentChanged'});
  assert.equal((await f.expand('escape.md','include')).complete,false);
  await fs.symlink(path.join(f.root,'a.md'),path.join(f.root,'link.md'));
  await assert.rejects(f.service.execute({command:'expand-directive',arguments:{file:'link.md',line:1}}),{code:'fileNotFound'});
  await assert.rejects(fs.readFile(path.join(f.directory,'counts.txt')),{code:'ENOENT'});
});

test('callback/loading/timeout/unsupported failures preserve useful content and cancellation terminates workers', async t => {
  const f=await fixture({...pluginFiles,'guide.md':':::{demo:fail}\n:::\n\n:::{demo:hang}\n:::\n\n:::{demo:unknown-node}\n:::\n'}); t.after(f.cleanup);
  const failed=await f.expand('guide.md','demo:fail'); assert.equal(failed.complete,false); assert.match(failed.content,/CALLBACK_FAILURE/);
  const unsupported=await f.expand('guide.md','demo:unknown-node'); assert.equal(unsupported.complete,false); assert.match(unsupported.content,/READABLE_CHILD/);
  const timed=new IndexService(f.root,f.cache,{allowProjectPlugins:true,timeoutMs:400});
  const timeout=await timed.execute({command:'expand-directive',arguments:{file:'guide.md',line:4}}); assert.ok('expansion' in timeout); assert.equal(timeout.complete,false); assert.match(timeout.diagnostics[0].message,/runtime limit/);
  await assert.rejects(f.service.execute({command:'expand-directive',arguments:{file:'guide.md',line:4}},{signal:AbortSignal.timeout(100)}),{name:'TimeoutError'});
  await f.write('plugin.mjs','throw new Error("LOAD_FAILURE");'); const loading=await f.expand('guide.md','demo:fail'); assert.equal(loading.complete,false); assert.match(loading.content,/demo:fail/); assert.ok(loading.diagnostics.some(issue=>/LOAD_FAILURE/.test(issue.message)));
});

test('stdio and HTTP expansion agree with the API and expose execution annotations and launch-only opt-in', {timeout:20000}, async t => {
  const f=await fixture({...pluginFiles,'guide.md':':::{demo:greeting} reader\n:::\n\n:::{include} target.md\n:::\n','target.md':'LOCAL_CONTENT\n'}); t.after(f.cleanup);
  const handle=await startHttp(f.service,{host:'127.0.0.1',port:0,allowedHosts:['127.0.0.1'],allowedOrigins:['127.0.0.1']},()=>{});
  const clients=[new Client({name:'expand-stdio',version:'1'}),new Client({name:'expand-http',version:'1'})];
  try{
    await clients[0].connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/mcp.cjs'),'--root',f.root,'--cache-dir',f.cache,'--no-watch','--allow-project-plugins'],stderr:'pipe'}));
    await clients[1].connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    const query={command:'expand-directive' as const,arguments:{file:'guide.md',line:1}};
    const expected=presentResult(await f.service.execute(query),query);
    for(const client of clients){
      const tool=(await client.listTools()).tools.find(item=>item.name==='expand_directive')!; assert.equal(tool.annotations?.readOnlyHint,false); assert.equal(tool.annotations?.idempotentHint,false);
      const result=await client.callTool({name:'expand_directive',arguments:query.arguments}); assert.deepEqual(result.structuredContent,expected); assertRetrievalResult(result.structuredContent);
      assert.equal((await client.callTool({name:'expand_directive',arguments:{...query.arguments,allowProjectPlugins:true}})).isError,true);
      const partial=await client.callTool({name:'expand_directive',arguments:{...query.arguments,maxChars:3}}); assert.equal(partial.isError,true); assert.equal((partial.structuredContent as any).complete,false);
    }
  }finally{await Promise.all(clients.map(client=>client.close()));await handle.close();}
});
