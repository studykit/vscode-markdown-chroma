import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const previewScript = () => readFileSync('dist/preview.js', 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const iconCallout = '<details class="callout obsidian-callout" data-callout="custom"><summary class="obsidian-callout-title"><span class="obsidian-callout-icon"><svg viewBox="0 0 24 24"><path d="M1 1h2"/></svg></span><span>Title</span></summary><p>Body</p></details>';

test('page load leaves Mermaid source and diagrams owned by other preview renderers unchanged', async () => {
  const html = '<pre class="mermaid">sequenceDiagram\n  Reader->>Service: Open document</pre>' +
    '<div class="mermaid"><svg xmlns="http://www.w3.org/2000/svg"><text>Previously rendered diagram</text></svg></div>';
  const page = new JSDOM(html, { runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  try {
    const before = page.window.document.body.innerHTML;
    page.window.eval(previewScript());
    page.window.dispatchEvent(new page.window.Event('load'));
    await tick();
    assert.equal(page.window.document.body.innerHTML, before);
    assert.equal(page.window.document.querySelector('[data-processed]'), null);
  } finally { page.window.close(); }
});

test('folding works with keyboard-native details and survives content replacement', async () => {
  const callout = '<details class="obsidian-callout" data-callout="note"><summary>Title</summary><p>Body</p></details>';
  const page = new JSDOM(callout, { runScripts: 'outside-only' });
  page.window.eval(previewScript());
  const details = page.window.document.querySelector('details')!;
  details.open = true;
  details.dispatchEvent(new page.window.Event('toggle'));
  page.window.document.body.innerHTML = callout;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(page.window.document.querySelector('details')!.open, true);
  page.window.close();
});

test('CSS selects Lucide aliases, changes icons after stylesheet updates and retains folding state', async () => {
  const page = new JSDOM(`<style>.callout[data-callout="custom"] { --callout-icon: lucide-alert-circle; --callout-color: 10, 20, 30; }</style>${iconCallout}`, { runScripts: 'outside-only' });
  page.window.eval(previewScript());
  const doc = page.window.document;
  const callout = doc.querySelector('details')!;
  assert.ok(callout.querySelector('.obsidian-callout-icon circle'));
  assert.equal(callout.style.getPropertyValue('--obsidian-callout-color'), 'rgb(10, 20, 30)');
  callout.open = true;
  callout.dispatchEvent(new page.window.Event('toggle'));
  doc.querySelector('style')!.textContent = '.callout[data-callout="custom"] { --callout-icon: lucide-flame; --callout-color: #8b5cf6; }';
  await tick();
  assert.equal(callout.querySelector('.obsidian-callout-icon circle'), null);
  assert.equal(callout.style.getPropertyValue('--obsidian-callout-color'), '');
  const flame = callout.querySelector('.obsidian-callout-icon')!.innerHTML;
  doc.body.innerHTML = iconCallout;
  await tick();
  assert.equal(doc.querySelector('details')!.open, true);
  assert.equal(doc.querySelector('.obsidian-callout-icon')!.innerHTML, flame);
  page.window.close();
});

test('custom SVG icons render without xmlns and discard scripts, events and external resources', async () => {
  const page = new JSDOM(iconCallout, { runScripts: 'outside-only' });
  const callout = page.window.document.querySelector('details')!;
  callout.style.setProperty('--callout-icon', `'<svg viewBox="0 0 24 24" onload="alert(1)"><script>alert(1)</script><foreignObject><iframe src="https://example.com"/></foreignObject><path d="M4 12h16" stroke="currentColor" onclick="alert(1)"/><circle cx="12" cy="12" r="4" fill="url(https://example.com/x)"/></svg>'`);
  page.window.eval(previewScript());
  const svg = callout.querySelector('.obsidian-callout-icon svg')!;
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(svg.querySelector('path')?.getAttribute('d'), 'M4 12h16');
  assert.doesNotMatch(svg.outerHTML, /script|iframe|foreignObject|onload|onclick|https:/);
  assert.equal(svg.querySelector('circle')?.getAttribute('fill'), null);
  callout.style.setProperty('--callout-icon', 'unknown-icon');
  callout.append(page.window.document.createElement('p'));
  await tick();
  assert.equal(callout.querySelector('.obsidian-callout-icon path')?.getAttribute('d'), 'M1 1h2');
  page.window.close();
});

test('MyST tabs support clicks, arrow keys and replaced preview contents', async () => {
  const html = '<div class="myst-tabs"><div role="tablist"><button role="tab" aria-selected="true">One</button><button role="tab" aria-selected="false">Two</button></div><div role="tabpanel">First</div><div role="tabpanel" hidden>Second</div></div>';
  const page = new JSDOM(html, { runScripts: 'outside-only' });
  page.window.eval(previewScript());
  let tabs = page.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  tabs[1].click();
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(page.window.document.querySelectorAll<HTMLElement>('[role="tabpanel"]')[1].hidden, false);
  tabs[1].dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(page.window.document.activeElement, tabs[0]);
  page.window.document.body.innerHTML = html;
  await tick();
  tabs = page.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  tabs[1].click();
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  page.window.close();
});
