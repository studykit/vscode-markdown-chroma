import { build, context } from 'esbuild';
import { cp, copyFile, mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist/test', { recursive: true });
for (const file of await readdir('dist/test')) if (file.endsWith('.cjs')) await rm(`dist/test/${file}`);
await rm('dist/katex', { recursive: true, force: true });
await mkdir('dist/katex', { recursive: true });
await copyFile('node_modules/katex/dist/katex.min.css', 'dist/katex/katex.min.css');
await cp('node_modules/katex/dist/fonts', 'dist/katex/fonts', { recursive: true });
const previewBuild = { entryPoints: ['media/preview.js'], outfile: 'dist/preview.js', bundle: true, platform: 'browser', format: 'iife', target: 'chrome122', minify: true };
const tests = (await readdir('test')).filter(name => name.endsWith('.test.ts'));
const builds = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs' },
  ...tests.map(name => ({ entryPoints: [`test/${name}`], outfile: `dist/test/${name.replace('.ts', '.cjs')}` })),
  { entryPoints: ['test/integration.ts'], outfile: 'dist/integration.cjs' }
].map(options => ({
  ...options, bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  mainFields: ['module', 'main'],
  external: ['vscode', 'jsdom'], sourcemap: true, logLevel: 'info', metafile: true
}));

if (process.argv.includes('--watch')) {
  await (await context(previewBuild)).watch();
  for (const options of builds) await (await context(options)).watch();
} else {
  const results = await Promise.all([build({ ...previewBuild, metafile: true }), ...builds.map(options => build(options))]);
  const packages = new Set(['node_modules/katex']);
  for (const result of results) for (const input of Object.keys(result.metafile.inputs)) {
    const matches = [...input.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
    if (matches.length) { const match = matches.at(-1); packages.add(input.slice(0, match.index + match[0].length)); }
  }
  const bundledNotices = await Promise.all([...packages].sort().map(async root => {
    const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
    const filenames = (await readdir(root)).filter(file => /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(file));
    const licenses = await Promise.all(filenames.map(file => readFile(`${root}/${file}`, 'utf8').catch(() => '')));
    return `${manifest.name} ${manifest.version} (${manifest.license ?? 'see upstream license'})\n${'='.repeat(60)}\n${licenses.join('\n')}`;
  }));
  await writeFile('dist/THIRD_PARTY_NOTICES.txt', bundledNotices.join('\n\n'));

}
