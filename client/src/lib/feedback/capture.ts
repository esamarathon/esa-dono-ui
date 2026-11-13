// Feedback capture — the DOM snapshot and the screenshot's pure plumbing,
// ported from the esa-crew-corner feedback bubble (docs/FEEDBACK.md there,
// §4.2 "Screenshot fidelity" and "The details fix"). Runs in the browser; kept
// free of browser globals so it unit-tests against a jsdom document.
//
// Why a snapshot next to the picture: it is an exact record of what the page
// showed — every input's CURRENT value, the chosen option, the ticked box —
// and it re-renders later in a browser with the real stylesheets, which a PNG
// can never do. Password and file inputs are never captured.

/** The snapshot's own when/where marker, readable when the file is opened later. */
export const FEEDBACK_DIAG_META_NAME = 'dono-feedback-snapshot';

/** The floating widget's DOM id; captures exclude it. */
export const FEEDBACK_BUTTON_ID = 'dono-feedback-button';

export type SnapshotOptions = {
  /** `location.href` at capture time. */
  url: string;
  scrollY: number;
  /** CSS selectors removed from the clone (the widget and its modal). */
  exclude: string[];
  /** Injected so tests are deterministic. */
  now?: Date;
};

type FormField = Element & {
  type?: string;
  value?: string;
  checked?: boolean;
  options?: ArrayLike<Element>;
};

function copyFieldState(live: FormField, clone: FormField): void {
  const tag = live.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (live.type ?? 'text').toLowerCase();
    if (type === 'password' || type === 'file') {
      clone.removeAttribute('value');
      return;
    }
    if (type === 'checkbox' || type === 'radio') {
      if (live.checked) clone.setAttribute('checked', '');
      else clone.removeAttribute('checked');
      return;
    }
    clone.setAttribute('value', live.value ?? '');
    return;
  }
  if (tag === 'textarea') {
    clone.textContent = live.value ?? '';
    return;
  }
  if (tag === 'select') {
    const liveOptions = live.options ?? [];
    const cloneOptions = clone.options ?? [];
    for (let i = 0; i < liveOptions.length; i++) {
      const option = liveOptions[i] as Element & { selected?: boolean };
      const target = cloneOptions[i];
      if (!target) continue;
      if (option.selected) target.setAttribute('selected', '');
      else target.removeAttribute('selected');
    }
  }
}

/**
 * Serialise the page as it stands: a deep clone of `<html>` with live form
 * state written in as attributes, scripts and the excluded elements removed,
 * a `<base>` so relative URLs still resolve when the file is opened later,
 * and a meta tag with when/where it was taken.
 */
export function buildDomSnapshot(doc: Document, opts: SnapshotOptions): string {
  const root = doc.documentElement;
  const clone = root.cloneNode(true) as HTMLElement;

  // Walk live and clone in parallel: same document order, same element count
  // (cloneNode copies the tree structurally), so index i maps to index i.
  const liveFields = root.querySelectorAll('input, textarea, select');
  const cloneFields = clone.querySelectorAll('input, textarea, select');
  for (let i = 0; i < liveFields.length; i++) {
    const target = cloneFields[i];
    if (target) copyFieldState(liveFields[i] as FormField, target as FormField);
  }

  // <link rel=modulepreload>/preload hints stay: harmless in the sandboxed
  // snapshot and they do not execute anything.
  clone.querySelectorAll('script').forEach((s) => s.remove());
  for (const selector of opts.exclude ?? []) {
    clone.querySelectorAll(selector).forEach((el) => el.remove());
  }

  let head = clone.querySelector('head');
  if (!head) {
    head = doc.createElement('head');
    clone.insertBefore(head, clone.firstChild);
  }
  const base = doc.createElement('base');
  base.setAttribute('href', `${new URL(opts.url).origin}/`);
  const meta = doc.createElement('meta');
  meta.setAttribute('name', FEEDBACK_DIAG_META_NAME);
  meta.setAttribute(
    'content',
    JSON.stringify({
      at: (opts.now ?? new Date()).toISOString(),
      url: opts.url,
      scrollY: Math.round(opts.scrollY),
    }),
  );
  head.insertBefore(meta, head.firstChild);
  head.insertBefore(base, head.firstChild);

  return `<!doctype html>\n${clone.outerHTML}`;
}

// ---------------------------------------------------------------------------
// Screenshot clone sanitizer ("The details fix").
//
// html2canvas(-pro) does not know that the content of a CLOSED <details> is
// not rendered: it draws those children anyway, and it numbers <summary> like
// a list item (its UA display is list-item). A perfectly fine page then looks
// broken in the PNG. html2canvas calls `onclone` with its private copy of the
// document, so we fix the CLONE and the live page is never touched.

const SUMMARY_RESET_CSS =
  'summary{display:block;list-style:none}summary::-webkit-details-marker{display:none}';

export const SUMMARY_RESET_ATTR = 'data-dono-feedback-summary-reset';

/**
 * For every closed `<details>` in `doc`: remove every child except its first
 * direct `<summary>`. Then neutralise the summary marker (type selectors, so
 * authored classes such as `.flex` still win). Idempotent. Nested closed
 * details are handled too: the outer one drops its whole subtree, and an OPEN
 * details still prunes its own closed descendants.
 */
export function sanitizeClonedDocument(doc: Document): void {
  const closed = Array.from(doc.querySelectorAll('details:not([open])'));
  for (const details of closed) {
    // A previous removal may have detached this node (nested in a closed one).
    if (!details.isConnected) continue;
    let keep: Element | null = null;
    for (const child of Array.from(details.children)) {
      if (child.tagName.toLowerCase() === 'summary') {
        keep = child;
        break;
      }
    }
    for (const node of Array.from(details.childNodes)) {
      if (node !== keep) node.parentNode?.removeChild(node);
    }
  }
  if (doc.querySelector(`style[${SUMMARY_RESET_ATTR}]`)) return;
  const style = doc.createElement('style');
  style.setAttribute(SUMMARY_RESET_ATTR, '');
  style.textContent = SUMMARY_RESET_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

// ---------------------------------------------------------------------------
// Screenshot fidelity (the crew-corner FB-1 lesson).
//
// - `scrollX/scrollY: 0` pin html2canvas's idea of the scroll position. By
//   default it adds `window.scrollY` to every box, but its hidden clone window
//   can only scroll as far as the page allows — a scrolled page then comes out
//   drawn hundreds of pixels too low.
// - `windowHeight` is the REAL window height, not the page height. A clone
//   window as tall as the page makes every `vh` length grow to the page
//   height, re-laying the page out bigger than the sender saw it.
// - `height` is what is painted: the whole page, capped.
export type ScreenshotPage = {
  /** `window.innerHeight`: the sender's real viewport height. */
  innerHeight: number;
  /** `document.body.scrollHeight`: the whole page. */
  scrollHeight: number;
  /** Computed background colour of `<body>`; empty when unknown. */
  backgroundColor: string;
};

export function screenshotOptions(page: ScreenshotPage, maxHeight: number) {
  const viewport = page.innerHeight > 0 ? page.innerHeight : page.scrollHeight;
  return {
    scale: 1,
    useCORS: true,
    logging: false,
    scrollX: 0,
    scrollY: 0,
    windowHeight: Math.round(viewport),
    height: Math.min(Math.round(page.scrollHeight), maxHeight),
    backgroundColor: page.backgroundColor || null,
  };
}

// An <img> of an SVG that declares a viewBox but no width/height has no
// intrinsic size, and Chromium then answers drawImage(...) with a magnified,
// cropped picture — a brand emblem vanished this way. Giving the SVG text a
// width and height (taken from its viewBox) in the clone fixes it; an SVG
// that is already sized draws correctly.

const XML_OR_SVG_TAG = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<svg\b[^>]*>/gi;
const FIXED_LENGTH = /^\+?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|ex|pt|pc|cm|mm|in)?$/i;

function attributeOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? (m[1] ?? m[2] ?? '').trim() : null;
}

/**
 * `svg` with `width` and `height` on its root element, taken from its viewBox,
 * or `null` when nothing needs to (or can) change: no root element, a root
 * that already has fixed numeric width AND height, or no usable viewBox. A
 * root with percentage or half-declared sizes gets both replaced.
 */
export function svgWithIntrinsicSize(svg: string): string | null {
  let root: RegExpExecArray | null = null;
  XML_OR_SVG_TAG.lastIndex = 0;
  for (let m = XML_OR_SVG_TAG.exec(svg); m; m = XML_OR_SVG_TAG.exec(svg)) {
    if (m[0].slice(0, 4).toLowerCase() === '<svg') {
      root = m;
      break;
    }
  }
  if (!root) return null;
  const tag = root[0];
  const width = attributeOf(tag, 'width');
  const height = attributeOf(tag, 'height');
  if (width && height && FIXED_LENGTH.test(width) && FIXED_LENGTH.test(height)) return null;
  const parts = (attributeOf(tag, 'viewBox') ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2]! <= 0 || parts[3]! <= 0) {
    return null;
  }
  const sized = tag
    .replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/g, '')
    .replace(/^<svg\b/i, `<svg width="${parts[2]}" height="${parts[3]}"`);
  return svg.slice(0, root.index) + sized + svg.slice(root.index + tag.length);
}

const SVG_URL = /^[^#?]*\.svg(?:[?#]|$)/i;

/** Fetches the text of an SVG; `null` on any failure (offline, CORS, 404, too big). */
export type ReadSvg = (url: string) => Promise<string | null>;

/**
 * In the screenshot clone, replace every `<img>` of an unsized SVG with a fresh
 * `<img>` (same attributes and place) whose source is an equivalent data URL
 * that has an intrinsic size (see `svgWithIntrinsicSize`). One read per
 * distinct URL. Never throws: an image whose SVG cannot be read stays as it
 * was. Returns how many images were replaced.
 *
 * A fresh element, not a changed `src`: Firefox keeps reporting the OLD
 * `currentSrc` (and size) on an element whose `src` was just changed, and
 * html2canvas draws from `currentSrc || src`.
 */
export async function sizeSvgImages(doc: Document, readSvg: ReadSvg): Promise<number> {
  const reads = new Map<string, Promise<string | null>>();
  const swaps: Promise<boolean>[] = [];
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const url = img.currentSrc || img.src;
    if (!url || !SVG_URL.test(url)) continue;
    let sized = reads.get(url);
    if (!sized) {
      sized = readSvg(url)
        .then((text) => (text ? svgWithIntrinsicSize(text) : null))
        .catch(() => null);
      reads.set(url, sized);
    }
    swaps.push(
      sized.then((svg) => {
        if (!svg || !img.parentNode) return false;
        const fresh = doc.createElement('img');
        for (const attr of Array.from(img.attributes)) {
          if (attr.name !== 'src' && attr.name !== 'srcset' && attr.name !== 'loading') {
            fresh.setAttribute(attr.name, attr.value);
          }
        }
        fresh.setAttribute('loading', 'eager');
        fresh.setAttribute('src', `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
        img.parentNode.replaceChild(fresh, img);
        return true;
      }),
    );
  }
  return (await Promise.all(swaps)).filter(Boolean).length;
}
