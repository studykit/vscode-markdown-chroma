import assert from 'node:assert/strict';

export const obsidianBlockSource = `---
title: Block references
---

# References

[[#^item]] [[#^paragraph]] [[#^list]] [[#^quote]] [[#^table]] [[#^callout]] [[#References]]

Paragraph **content**. ^paragraph

- src/docs/ ^docs
- src/lib/ ^item

^list

> Quote content.

^quote

| Name | Value |
| --- | --- |
| Item | Content |

^table

> [!tip]- Callout
> Callout content.

^callout

\`\`\`md
Literal ^fake
\`\`\`

Inline \`Literal ^inline\` and escaped \\^escaped.
`;

export function assertObsidianBlocks(document: Document): void {
  for (const [id, tag] of [['docs', 'LI'], ['item', 'LI'], ['paragraph', 'P'], ['list', 'UL'], ['quote', 'BLOCKQUOTE'], ['table', 'TABLE'], ['callout', 'DETAILS']]) {
    const target = document.getElementById(`obsidian-block-${id}`);
    assert.equal(target?.tagName, tag, id);
    assert.doesNotMatch(target!.textContent ?? '', new RegExp(`\\^${id}\\b`));
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a.obsidian-link')) {
    assert.ok(document.getElementById(link.getAttribute('href')!.slice(1)), link.outerHTML);
  }
  assert.equal(document.querySelectorAll('a.obsidian-link').length, 7);
  assert.equal(document.querySelector('.is-unresolved'), null);
  assert.equal(document.getElementById('obsidian-block-fake'), null);
  assert.equal(document.getElementById('obsidian-block-inline'), null);
  assert.equal(document.getElementById('obsidian-block-escaped'), null);
  assert.match(document.querySelector('pre code')?.textContent ?? '', /Literal \^fake/);
}
