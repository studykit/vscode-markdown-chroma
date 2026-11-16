import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

export interface PrintOptions {
  executablePath: string;
  /** Standalone page written by `buildPdfHtml`. */
  html: string;
  output: string;
  format: 'A4' | 'Letter';
  timeoutMs?: number;
}

/** Print a standalone preview page to PDF with an installed Chromium-based browser. */
export async function printPdf(options: PrintOptions): Promise<void> {
  const timeout = options.timeoutMs ?? 30000;
  const browser = await puppeteer.launch({
    executablePath: options.executablePath,
    headless: true,
    // Do not inherit the user's profile or extensions.
    args: ['--disable-extensions', '--no-first-run', '--no-default-browser-check', '--disable-background-networking'],
    timeout
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    await page.emulateMediaType('print');
    await page.goto(pathToFileURL(options.html).href, { waitUntil: 'load' });
    // Print hides nothing: expand folded callouts, dropdowns and term details.
    await page.evaluate(() => { document.querySelectorAll('details').forEach(element => { element.open = true; }); });
    // preview.js renders Mermaid asynchronously; a failed diagram gets a title and keeps its source.
    await page.waitForFunction(() => [...document.querySelectorAll('.myst-mermaid')]
      .every(element => element.querySelector('svg') || element.hasAttribute('title')), { polling: 100 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].filter(image => !image.complete)
        .map(image => new Promise(resolve => { image.addEventListener('load', resolve); image.addEventListener('error', resolve); })));
    });
    await page.pdf({
      path: options.output,
      format: options.format,
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
      timeout
    });
  } finally {
    await browser.close();
  }
}
