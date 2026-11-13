import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
// jsdom ships its own types only behind @types

import {
  buildDomSnapshot,
  sanitizeClonedDocument,
  screenshotOptions,
  sizeSvgImages,
  svgWithIntrinsicSize,
  SUMMARY_RESET_ATTR,
} from '../../../src/lib/feedback/capture';

// Ported from the esa-crew-corner capture tests: the DOM snapshot, the clone
// sanitizer, the screenshot options and the unsized-SVG fix are pure, so they
// test against a jsdom document with no browser.

function doc(html: string): Document {
  return new JSDOM(html).window.document;
}

describe('buildDomSnapshot', () => {
  it('writes the CURRENT value of every field into the clone as attributes', () => {
    const live = new JSDOM(`
      <html><head><title>t</title></head><body>
        <input id="a" value="stale"><input id="b" type="checkbox"><textarea id="c">stale</textarea>
        <select id="e"><option value="x">x</option><option value="y">y</option></select>
      </body></html>`);
    (live.window.document.getElementById('a') as HTMLInputElement).value = 'typed';
    (live.window.document.getElementById('b') as HTMLInputElement).checked = true;
    (live.window.document.getElementById('c') as HTMLTextAreaElement).value = 'typed note';
    const select = live.window.document.getElementById('e') as HTMLSelectElement;
    select.value = 'y';

    const html = buildDomSnapshot(live.window.document, {
      url: 'http://localhost:3001/donate',
      scrollY: 10,
      exclude: [],
    });
    expect(html).toContain('<input id="a" value="typed"');
    expect(html).toMatch(/<input id="b"[^>]*checked/);
    expect(html).toContain('typed note');
    expect(html).toContain('<option value="y" selected=""');
    expect(html).not.toContain('<option value="x" selected=""');
  });

  it('never captures password or file input values', () => {
    const d = doc(`
      <html><head></head><body>
        <input id="pw" type="password" value="hunter2">
        <input id="f" type="file" value="C:\\fakepath\\secret.pdf">
      </body></html>`);
    (d.getElementById('pw') as HTMLInputElement).value = 'hunter2';
    const html = buildDomSnapshot(d, { url: 'http://localhost:3001/', scrollY: 0, exclude: [] });
    expect(html).not.toContain('hunter2');
    expect(html).not.toContain('secret.pdf');
  });

  it('removes scripts and excluded selectors, and adds base + the meta marker', () => {
    const d = doc(`
      <html><head><script>console.log('x')</script></head><body>
        <div id="widget">widget</div><main>content</main>
      </body></html>`);
    const html = buildDomSnapshot(d, {
      url: 'http://localhost:3001/donate?x=1',
      scrollY: 3,
      exclude: ['#widget'],
      now: new Date('2026-11-13T00:00:00.000Z'),
    });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('>widget<');
    expect(html).toContain('<base href="http://localhost:3001/">');
    expect(html).toContain('dono-feedback-snapshot');
    expect(html).toContain('2026-11-13T00:00:00.000Z');
    expect(html).toContain('&quot;scrollY&quot;:3');
    expect(html).toContain('<!doctype html>');
  });

  it('keeps a headless document working (no head element)', () => {
    const d = doc('<html><body><input value="a"></body></html>');
    const html = buildDomSnapshot(d, { url: 'http://localhost/', scrollY: 0, exclude: [] });
    expect(html).toContain('<base');
    expect(html).toContain('value="a"');
  });
});

describe('sanitizeClonedDocument', () => {
  it('drops the children of closed details and keeps the summary', () => {
    const d = doc(`
      <html><head></head><body>
        <details><summary>Open me</summary><p>hidden content</p></details>
        <details open><summary>Shown</summary><p>visible content</p></details>
      </body></html>`);
    sanitizeClonedDocument(d);
    const closed = d.querySelectorAll('details')[0]!;
    const open = d.querySelectorAll('details')[1]!;
    expect(closed.children).toHaveLength(1);
    expect(closed.children[0]!.tagName).toBe('SUMMARY');
    expect(closed.textContent).not.toContain('hidden content');
    expect(open.textContent).toContain('visible content');
    // The summary marker is neutralised in the clone only.
    expect(d.querySelector(`style[${SUMMARY_RESET_ATTR}]`)).toBeTruthy();
  });

  it('is idempotent', () => {
    const d = doc(
      '<html><head></head><body><details><summary>s</summary><p>x</p></details></body></html>',
    );
    sanitizeClonedDocument(d);
    const afterFirst = d.body.innerHTML;
    sanitizeClonedDocument(d);
    expect(d.body.innerHTML).toBe(afterFirst);
  });

  it('prunes a closed details nested inside an open one', () => {
    const d = doc(`
      <html><head></head><body>
        <details open><summary>outer</summary><details><summary>inner</summary><p>secret</p></details></details>
      </body></html>`);
    sanitizeClonedDocument(d);
    expect(d.body.textContent).not.toContain('secret');
    expect(d.body.textContent).toContain('inner');
  });
});

describe('screenshotOptions', () => {
  it('pins the scroll to the top, keeps the real window height, and caps the painted height', () => {
    const options = screenshotOptions(
      { innerHeight: 900, scrollHeight: 5000, backgroundColor: 'rgb(25, 25, 25)' },
      4000,
    );
    expect(options).toMatchObject({
      scrollX: 0,
      scrollY: 0,
      windowHeight: 900,
      height: 4000,
      backgroundColor: 'rgb(25, 25, 25)',
    });
  });

  it('falls back to the page height when the window height is unknown', () => {
    const options = screenshotOptions(
      { innerHeight: 0, scrollHeight: 800, backgroundColor: '' },
      4000,
    );
    expect(options.windowHeight).toBe(800);
    expect(options.backgroundColor).toBeNull();
  });
});

describe('svgWithIntrinsicSize', () => {
  it('sizes an unsized SVG from its viewBox', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M0 0h48v48H0z"/></svg>`;
    const sized = svgWithIntrinsicSize(svg)!;
    expect(sized).toContain('width="48"');
    expect(sized).toContain('height="48"');
  });

  it('leaves already-sized SVGs and unparseable text alone', () => {
    expect(
      svgWithIntrinsicSize('<svg width="48" height="48" viewBox="0 0 48 48"></svg>'),
    ).toBeNull();
    expect(svgWithIntrinsicSize('<svg viewBox="0 0 0 0"></svg>')).toBeNull();
    expect(svgWithIntrinsicSize('not svg at all')).toBeNull();
  });
});

describe('sizeSvgImages', () => {
  it('replaces unsized SVG <img> elements with data-URL twins', async () => {
    const d = doc(`
      <html><head></head><body>
        <img id="logo" src="/brand/emblem.svg">
        <img id="plain" src="/photo.png">
      </body></html>`);
    const replaced = await sizeSvgImages(d, async (url) => {
      expect(url).toContain('emblem.svg');
      return '<svg viewBox="0 0 48 48"></svg>';
    });
    expect(replaced).toBe(1);
    const logo = d.getElementById('logo') as HTMLImageElement;
    expect(logo.src).toContain('data:image/svg+xml');
    // The plain raster image is untouched.
    expect((d.getElementById('plain') as HTMLImageElement).src).toContain('photo.png');
  });

  it('never throws when the SVG cannot be read', async () => {
    const d = doc('<html><head></head><body><img src="/x.svg"></body></html>');
    const replaced = await sizeSvgImages(d, async () => null);
    expect(replaced).toBe(0);
    expect((d.querySelector('img') as HTMLImageElement).src).toContain('x.svg');
  });
});
