import assert from 'node:assert/strict';

export const unifiedPreviewSource = `# Unified preview

% Hidden MyST comment
%%Hidden Obsidian comment%% Visible text

Standalone $x^2$ and money $5 and $10.

Term
: Definition

:::{note}
==🟢**Highlighted** {kbd}\`Ctrl\`== #nested/tag

> [!tip]+ Inner {kbd}\`Enter\`
> ==**Body**== and {sub}\`2\`, inline^[Inline **note**].
:::

Reference[^named], again[^named].

[^named]: First paragraph.

    Last paragraph.

:::{dropdown} More
{chem}\`H2O\`
:::

\`\`\`{code-block} python
:linenos:
:lineno-start: 7
:emphasize-lines: 2
:caption: Example code
def greet(name):
    return "Hello " + name
\`\`\`

\`\`\`{table} Table caption
| A |
|---|
| B |
\`\`\`

\`\`\`{toc}
\`\`\`
`;

export function assertUnifiedPreview(document: Document): void {
  assert.doesNotMatch(document.body.textContent ?? '', /Hidden MyST|Hidden Obsidian/);
  assert.match(document.body.textContent ?? '', /Visible text/);
  assert.equal(document.querySelectorAll('.katex').length, 1);
  assert.match(document.body.textContent ?? '', /money \$5 and \$10/);
  assert.equal(document.querySelector('dt')?.textContent, 'Term');
  assert.equal(document.querySelector('mark[data-highlight="green"] strong')?.textContent, 'Highlighted');
  assert.equal(document.querySelector('mark kbd')?.textContent, 'Ctrl');
  assert.equal(document.querySelector('.myst-admonition .obsidian-tag')?.textContent, '#nested/tag');
  assert.equal(document.querySelector('.obsidian-callout summary kbd')?.textContent, 'Enter');
  assert.equal(document.querySelector('.obsidian-callout mark strong')?.textContent, 'Body');
  assert.equal(document.querySelector('.obsidian-callout sub')?.textContent, '2');
  const notes = [...document.querySelectorAll('.footnote-item')];
  assert.equal(notes.length, 2);
  for (const note of notes) assert.ok(note.querySelector('.obsidian-footnote-content > p:last-child .obsidian-footnote-backlinks'));
  assert.equal(notes[1].querySelectorAll('.obsidian-footnote-content > p').length, 2);
  assert.deepEqual([...notes[1].querySelectorAll('.obsidian-footnote-backref')].map(link => link.textContent), ['↩₁', '↩₂']);
  for (const link of document.querySelectorAll('.footnote-ref a, .obsidian-footnote-backref, .myst-toc a')) {
    assert.ok(document.getElementById(link.getAttribute('href')!.slice(1)), link.outerHTML);
  }
  assert.equal(document.querySelector('details > summary')?.textContent?.trim(), 'Inner Enter');
  assert.ok([...document.querySelectorAll('details')].some(node => node.querySelector('summary')?.textContent === 'More' && node.querySelector('sub')?.textContent === '2'));
  assert.deepEqual([...document.querySelectorAll('.myst-code-line')].map(line => line.getAttribute('data-line-number')), ['7', '8']);
  assert.match(document.querySelector('.myst-code-line.is-emphasized')?.textContent ?? '', /return "Hello " \+ name/);
  for (const figure of document.querySelectorAll('figure')) assert.equal(figure.firstElementChild?.tagName, 'FIGCAPTION');
}
