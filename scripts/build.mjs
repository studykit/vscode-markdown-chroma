import { build, context } from 'esbuild';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist/test', { recursive: true });
const dependencies = ['github-slugger', 'markdown-it-mark', 'yaml', 'lucide'];
const notices = await Promise.all(dependencies.map(async name => {
  const manifest = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  const license = await readFile(`node_modules/${name}/LICENSE`, 'utf8');
  return `${name} ${manifest.version}\n${'='.repeat(60)}\n${license}`;
}));
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n'));
const previewBuild = { entryPoints: ['media/preview.js'], outfile: 'dist/preview.js', bundle: true, platform: 'browser', format: 'iife', target: 'chrome122', minify: true };
const tests = (await readdir('test')).filter(name => name.endsWith('.test.ts'));
const builds = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs' },
  ...tests.map(name => ({ entryPoints: [`test/${name}`], outfile: `dist/test/${name.replace('.ts', '.cjs')}` })),
  { entryPoints: ['test/integration.ts'], outfile: 'dist/integration.cjs' }
].map(options => ({
  ...options, bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  mainFields: ['module', 'main'],
  external: ['vscode', 'markdown-it', 'jsdom'], sourcemap: true, logLevel: 'info'
}));

if (process.argv.includes('--watch')) {
  await (await context(previewBuild)).watch();
  for (const options of builds) await (await context(options)).watch();
} else {
  await Promise.all([build(previewBuild), ...builds.map(options => build(options))]);
}
