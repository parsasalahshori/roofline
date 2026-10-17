// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { embedSnippet } from '../src/features/quote/embed.ts';

/*
 * The instant quote page on a company's own site. The page runs in an iframe, so the host's CSS cannot reach it and its
 * CSS cannot reach the host: that is the whole isolation, and what is kept true here is what the iframe cannot do for
 * itself. The widget takes two things from the company (its logo and its one colour) and nothing from the host page.
 * A real-browser pass (a host page whose CSS sets fonts, colours, buttons and inputs with !important) found the frame
 * unchanged; these tests keep the pieces that made that true.
 */

const dir = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const cssOf = (folder: string) =>
  readdirSync(dir(folder))
    .filter((name) => name.endsWith('.css'))
    .map((name) => ({ name: `${folder.split('/').filter(Boolean).pop()}/${name}`, css: readFileSync(dir(`${folder}${name}`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));

// Everything the quote page's bundle styles: its own module, the roof photo, and the shared letterhead, steps and trust row
const BUNDLE = [...cssOf('../src/features/quote/'), ...cssOf('../src/features/public/')];

/** Every `selector { declarations }` pair of a stylesheet (flat: a rule inside @media is found on its own). */
function rules(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim().replace(/^[^{}]*\}/, '').trim(), body: m[2]!.trim() }));
}

describe('the quote page and a company\'s own site', () => {
  it('the page plumbing for the company colour is the shared one: no per-page --quote-accent anywhere', () => {
    for (const { name, css } of BUNDLE) expect(css, name).not.toContain('--quote-accent');
  });

  it('its CSS never styles the document it is in, except under the embedded flag the frame sets on itself', () => {
    for (const { name, css } of BUNDLE) {
      for (const [, inner] of css.matchAll(/:global\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g)) {
        // html[data-embedded] and html[data-embedded] body are the only document-level selectors
        expect(inner, `${name}: :global(${inner})`).toMatch(/^html\[data-embedded\]/);
      }
      // Nothing is pulled in from, or pointed at, anywhere else
      expect(css, name).not.toMatch(/@import/);
      expect(css, name).not.toMatch(/url\(\s*['"]?https?:/);
      // No bare element, universal or root selector: a stylesheet that has them would restyle whatever page it is put in
      for (const { selector } of rules(css)) {
        for (const part of selector.split(',').map((p) => p.trim())) {
          if (part.startsWith(':global(html[data-embedded]')) continue;
          expect(part, `${name}: ${part}`).not.toMatch(/^(html|body|\*|:root)\b/);
        }
      }
    }
  });

  it('framed, the document is one opaque surface that fills the frame: a dark host, or a frame the browser backs with black, cannot show through', () => {
    const css = BUNDLE.find((file) => file.name === 'quote/QuotePage.module.css')!.css;
    const all = rules(css);
    // The one rule that styles the document (html and body together) paints it with the surface, never see-through
    const document = all.find((rule) => rule.selector.includes(':global(html[data-embedded] body)'));
    expect(document?.selector.split(',').map((part) => part.trim())).toEqual([':global(html[data-embedded])', ':global(html[data-embedded] body)']);
    expect(document?.body).toMatch(/background:\s*var\(--surface\)/);
    const card = all.find((rule) => rule.selector === ':global(html[data-embedded]) .page');
    expect(card?.body).toMatch(/background:\s*var\(--surface\)/);
    expect(card?.body).toMatch(/min-height:\s*0/);
    // Nothing of its own that would need a see-through corner: the radius is the iframe's, from the snippet
    expect(card?.body).not.toMatch(/border-radius|box-shadow/);
  });

  it('framed, the letterhead keeps only the logo: the company name and phone are on the page around it', () => {
    const css = BUNDLE.find((file) => file.name === 'public/PublicHeader.module.css')!.css;
    const all = rules(css);
    const hidden = all.find((rule) => rule.selector.includes(':global(html[data-embedded]) .call') && rule.selector.includes(':global(html[data-embedded]) .wordmark'));
    expect(hidden?.body).toMatch(/display:\s*none/);
    // And with no logo there is no letterhead at all
    const empty = all.find((rule) => rule.selector.includes('.site:not([data-logo])'));
    expect(empty?.body).toMatch(/display:\s*none/);
  });

  it('the snippet is an iframe to the page itself and reads only a height from it, from that origin only', () => {
    const code = embedSnippet('https://app.roofline.test/q/summit-ridge', 'Instant estimate');
    expect(code.startsWith('<iframe ')).toBe(true);
    expect(code).toContain('src="https://app.roofline.test/q/summit-ridge"');
    expect(code).toContain('e.origin !== "https://app.roofline.test"');
    // The only property read from a message is the height, and it is clamped
    expect(code).toContain('Number(e.data.height)');
    expect(code).toContain('Math.max(400, Math.min(4000,');
    expect(code).not.toMatch(/innerHTML|eval\(|document\.write/);
  });

  it('the snippet rounds the frame and rings it, since the page inside is one square opaque surface', () => {
    const code = embedSnippet('https://app.roofline.test/q/summit-ridge', 'Instant estimate');
    const style = /<iframe [^>]*style="([^"]*)"/.exec(code)?.[1] ?? '';
    expect(style).toContain('border-radius:14px');
    expect(style).toContain('box-shadow:0 0 0 1px');
    // A ring outside the box, not a border: a border would add width to a frame that is 100% wide and make the host scroll sideways
    expect(style).toContain('border:0');
    expect(style).toContain('width:100%');
  });
});
