import assert from 'node:assert/strict';

export const termDefBlock = [
  ':::{term-def} Cache worker',
  ':ko: 캐시 작업자',
  ':aliases: Cache handler',
  ':formerly: Store worker, 이전 작업자',
  ':distinct-from: Legacy',
  '',
  'Processes **cached records**.',
  '',
  '- See {term}`Legacy`.',
  ':::',
].join('\n');

export const termDefSource = [
  '# Terms', '',
  ':::{glossary}', 'Legacy', ': A standard glossary entry.', ':::', '',
  termDefBlock, '',
  ':::{term-def} Plain term', 'A definition without metadata.', ':::', '',
  '{term}`Cache worker` {term}`Cache handler` {term}`old label <Store worker>` {term}`캐시 작업자`',
].join('\n');

export const customTermConfig = [
  'project:', '  settings:', '    markdown_chroma:', '      term_directives:', '        kb-term:',
  '          aliases: names', '          formerly: previous', '',
].join('\n');
export const customTermSource = ':::{kb-term} Cache worker\n:names: Cache handler\n:previous: Store worker\n\nDefinition.\n:::';

export function assertTermDefPreview(doc: Document, language = 'en'): void {
  const definition = doc.querySelector('dl.myst-term-definition');
  assert.ok(definition);
  assert.equal(definition.querySelector('dt#term-cache-worker.code-line')?.getAttribute('data-line'), '7');
  assert.equal(definition.querySelector('dt span[lang="ko"]')?.textContent, '캐시 작업자');
  assert.equal(definition.querySelector('dd > p > strong')?.textContent, 'cached records');
  assert.equal(definition.querySelector('dd > ul a')?.getAttribute('href'), '#term-legacy');
  const details = definition.querySelector('details');
  assert.ok(details);
  assert.equal(details.open, false);
  assert.equal(details.querySelector('summary')?.textContent, language.startsWith('ko') ? '용어 정보' : 'Term information');
  assert.deepEqual([...details.querySelectorAll('dd')].map(item => item.textContent?.trim()), ['Cache handler', 'Store worker, 이전 작업자', 'Legacy']);
  assert.equal(details.querySelector('a')?.getAttribute('href'), '#term-legacy');
  assert.equal(doc.querySelector('#term-plain-term')?.parentElement?.querySelector('details'), null);
  assert.deepEqual([...doc.querySelectorAll('a[href="#term-cache-worker"]')].map(link => link.textContent?.trim()),
    ['Cache worker', 'Cache handler', 'old label', '캐시 작업자']);
  assert.equal(doc.querySelector('.myst-error, .myst-unresolved'), null);
}
