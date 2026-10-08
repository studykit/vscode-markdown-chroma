import assert from 'node:assert/strict';

// Official guide syntax, shared by standalone and actual VS Code render tests.
export const crossReferenceSource = `---
numbering:
  headings: true
---

(section)=
## Header *Targets*

[](#section) | @section | {ref}\`section\` | [Sec. **_%s_**](#section) | [Section "{name}"](#section)

\`\`\`{figure} assets/preview.svg
:label: figure
My **bold** caption.
\`\`\`

[](#figure) | @figure | {numref}\`Fig. %s <figure>\` | [Figure {number}: {name}](#figure)

\`\`\`{math}
:label: equation
e=mc^2
\`\`\`

[](#equation) | @equation | {eq}\`equation\`

\`\`\`{table} Table caption
:label: table

| A | B |
| - | - |
| 1 | 2 |
\`\`\`

[](#table) | @table | {numref}\`Table %s <table>\`

\`\`\`{code} python
:label: code
x = 1
\`\`\`

[](#code) | @code

(paragraph)=
This is just a paragraph!

(points)=
* Bullet
* points

[this paragraph](#paragraph) | {ref}\`these points <points>\`

[Literal \`%s\`](#figure)
`;

export function assertCrossReferences(document: Document): void {
  const texts = (id: string) => [...document.querySelectorAll(`a[href="#${id}"]`)].map(link => link.textContent?.replace(/\s+/g, ' '));
  assert.deepEqual(texts('section'), ['Section 1', 'Section 1', 'Section 1', 'Sec. 1', 'Section “Header Targets”']);
  assert.deepEqual(texts('figure'), ['Figure 1', 'Figure 1', 'Fig. 1', 'Figure 1: My bold caption.', 'Literal %s']);
  assert.deepEqual(texts('equation'), ['(1)', '(1)', '(1)']);
  assert.deepEqual(texts('table'), ['Table 1', 'Table 1', 'Table 1']);
  assert.deepEqual(texts('code'), ['Program 1', 'Program 1']);
  assert.equal(document.querySelector('a[href="#section"] strong em')?.textContent, '1');
  assert.ok(document.querySelector('#equation .katex'));
  assert.equal(document.querySelector('.myst-equation-number')?.textContent, '(1)');
  assert.equal(document.querySelectorAll('.myst-caption-number').length, 2);
  for (const link of document.querySelectorAll('a[href^="#"]')) {
    assert.ok(document.getElementById(link.getAttribute('href')!.slice(1)), `Missing target: ${link.outerHTML}`);
  }
  assert.equal(document.querySelector('.myst-unresolved, .myst-error, .myst-citation'), null);
}
