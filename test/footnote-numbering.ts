import assert from 'node:assert/strict';

export const manualFootnoteSource = '- A footnote reference[^myref]\n- Manually-numbered footnote reference[^3]\n\n[^myref]: This is an auto-numbered footnote definition.\n[^3]: This is a manually-numbered footnote definition.';
export const mixedFootnoteSource = 'First[^a], second[^b], manual[^1], third[^c], manual[^3], repeat[^a].\n\n[^a]: A\n[^b]: B\n[^c]: C\n[^1]: One\n[^3]: Three';

export function assertFootnoteNumbers(document: Document, expected: string[]): void {
  const references = [...document.querySelectorAll('.footnote-ref a')];
  assert.deepEqual(references.map(link => link.textContent), expected.map(number => `[${number}]`));
  for (const link of references) {
    const definition = document.getElementById(link.getAttribute('href')!.slice(1));
    assert.ok(definition);
    assert.equal(definition.querySelector('.obsidian-footnote-number')?.textContent, `${link.textContent!.slice(1, -1)}.`);
  }
  for (const link of document.querySelectorAll('.obsidian-footnote-backref')) {
    assert.ok(document.getElementById(link.getAttribute('href')!.slice(1)));
  }
}
