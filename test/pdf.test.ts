import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { browserCandidates, buildPdfHtml, findBrowser, pdfPathFor } from '../src/pdf/document';

const options = {
  body: '<h1>Title</h1><script>alert(1)</script>', title: 'A <b> & "c"', source: path.join(path.sep, 'notes', 'docs', 'Note.md'),
  styles: [path.join(path.sep, 'ext', 'preview.css')], script: path.join(path.sep, 'ext', 'preview.js'), nonce: 'n0nce'
};

test('PDF page resolves relative resources from the source folder and runs only the preview script', () => {
  const document = new JSDOM(buildPdfHtml(options)).window.document;
  assert.equal(document.querySelector('base')!.getAttribute('href'), 'file:///notes/docs/');
  assert.equal(document.title, 'A <b> & "c"');
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-n0nce'(?:;|$)/);
  const scripts = [...document.querySelectorAll('script')];
  assert.deepEqual(scripts.map(script => script.getAttribute('nonce')), [null, 'n0nce']);
  assert.equal(scripts[1].getAttribute('src'), 'file:///ext/preview.js');
  assert.equal(document.querySelector('link[rel="stylesheet"]')!.getAttribute('href'), 'file:///ext/preview.css');
  assert.ok(document.body.classList.contains('vscode-light'));
  assert.equal(document.body.getAttribute('style'), null);
});

test('PDF page applies preview font settings without breaking out of the style attribute', () => {
  const document = new JSDOM(buildPdfHtml({ ...options, fontFamily: 'Inter; color: red} "x"', fontSize: 15, lineHeight: 1.6 })).window.document;
  const style = document.body.getAttribute('style')!;
  assert.equal(style, '--markdown-font-family: Inter color: red "x"; --markdown-font-size: 15px; --markdown-line-height: 1.6;');
});

test('browser lookup honors the configured path and otherwise picks the first installed browser', () => {
  const installed = new Set(['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/opt/chrome']);
  const lookup = { platform: 'darwin' as const, env: { HOME: '/Users/me' }, exists: (file: string) => installed.has(file) };
  assert.equal(findBrowser('', lookup), '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  assert.equal(findBrowser(' /opt/chrome ', lookup), '/opt/chrome');
  assert.equal(findBrowser('/missing', lookup), undefined);
  assert.ok(browserCandidates(lookup).includes('/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  const windows = browserCandidates({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } });
  assert.equal(windows[0], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.ok(windows.includes('C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'));
  const linux = browserCandidates({ platform: 'linux', env: { PATH: '/usr/bin:/opt/bin' } });
  assert.deepEqual(linux.slice(0, 2), ['/usr/bin/google-chrome', '/opt/bin/google-chrome']);
});

test('default PDF path replaces the Markdown extension beside the source', () => {
  assert.equal(pdfPathFor(path.join('docs', 'Note.md')), path.join('docs', 'Note.pdf'));
  assert.equal(pdfPathFor(path.join('docs', 'archive.tar.md')), path.join('docs', 'archive.tar.pdf'));
});
