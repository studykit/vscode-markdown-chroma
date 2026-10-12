import assert from 'node:assert/strict';

export const glossaryLineBreakSource = `Ordinary first line
ordinary second line.

:::{glossary}
cache-node
**캐시 노드**
Cache worker

   A fictional component that keeps temporary records.
:::

:::{glossary}
Cache
: A **temporary** store with a normal
  continuation line.
:::

{term}\`Cache\`
{term}\`캐시 노드\` and {term}\`worker <Cache worker>\`
`;

export function assertGlossaryLineBreaks(document: Document): void {
  const glossary = document.querySelector('.myst-glossary');
  assert.ok(glossary);
  const terms = glossary.querySelector('dt');
  assert.ok(terms);
  assert.equal(terms.childNodes[0].textContent, 'cache-node');
  assert.equal(terms.children[0].tagName, 'BR');
  assert.equal(terms.children[1].tagName, 'SPAN');
  assert.equal(terms.children[1].textContent, '캐시 노드');
  assert.equal(terms.children[1].querySelector('strong')?.textContent, '캐시 노드');
  assert.equal(terms.children[3].textContent, 'Cache worker');
  assert.match(glossary.querySelector('dd')?.textContent ?? '', /fictional component/);
  assert.equal(document.querySelector('p')?.querySelector('br'), null);
  assert.equal(document.querySelector('dd')?.querySelector('br'), null);
  assert.equal(document.querySelectorAll('dt')[1]?.textContent, 'Cache');
  assert.equal(document.querySelector('dd strong')?.textContent, 'temporary');
  assert.equal(document.querySelector('a[href="#term-cache"]')?.textContent, 'Cache');
  assert.deepEqual([...document.querySelectorAll('a[href="#term-cache-node"]')].map(link => link.textContent), ['캐시 노드', 'worker']);
}
