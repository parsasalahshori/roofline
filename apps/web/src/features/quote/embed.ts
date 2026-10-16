/*
 * Embedding the instant quote page on a company's own website. The page runs inside an iframe there; it tells the
 * parent its height whenever it changes, and the snippet's small script resizes the iframe. The message carries
 * only a number, so any parent may read it.
 *
 * Isolation (REDESIGN 7.5): the iframe is all of it. The host page's CSS cannot reach the page (a host that sets fonts,
 * colours, buttons and inputs with !important changes nothing inside the frame, which was checked in a real browser),
 * and the page's CSS cannot reach the host. The page reads nothing from the host: from the company it takes its logo
 * and its one colour (applyBrand), and from the frame's own address nothing but the slug. Framed, `reportHeight` marks
 * the document `data-embedded`: the page then has no full-screen minimum, no letterhead but the logo, and an opaque
 * surface that fills the frame (so a dark section of the host cannot swallow its ink, and the frame needs no see-through
 * corners). The snippet rounds the iframe and gives it a hairline ring, which is where the card's corners come from.
 * The contract is kept by test/embed-contract.test.ts.
 */

export const RESIZE_MESSAGE = 'roofline-quote:height';

/** Inside an iframe: posts the document's height to the parent on every change. Returns the stop function. */
export function reportHeight(win: Window = window): () => void {
  if (win.parent === win) return () => undefined;
  // Embedded, the page is as tall as its content (no full-screen minimum), so the frame can shrink as well as grow.
  win.document.documentElement.setAttribute('data-embedded', '');
  const root = win.document.getElementById('root') ?? win.document.body;
  let last = 0;
  const send = () => {
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    win.parent.postMessage({ type: RESIZE_MESSAGE, height }, '*');
  };
  const observer = new ResizeObserver(send);
  observer.observe(root);
  send();
  return () => observer.disconnect();
}

/**
 * The code a company pastes on its site: the iframe and a script that resizes it from the page's messages, checking
 * that each message comes from the page's own origin. `pageUrl` is the page's full address.
 */
export function embedSnippet(pageUrl: string, title: string): string {
  const origin = new URL(pageUrl).origin;
  const id = 'roofline-quote';
  return [
    `<iframe id="${id}" src="${pageUrl}" title="${title.replace(/"/g, '&quot;')}" style="width:100%;border:0;border-radius:14px;box-shadow:0 0 0 1px rgba(127,127,127,.28);height:640px" loading="lazy" allow="clipboard-write"></iframe>`,
    `<script>`,
    `window.addEventListener("message", function (e) {`,
    `  if (e.origin !== "${origin}" || !e.data || e.data.type !== "${RESIZE_MESSAGE}") return;`,
    `  var f = document.getElementById("${id}");`,
    `  if (f) f.style.height = Math.max(400, Math.min(4000, Number(e.data.height) || 0)) + "px";`,
    `});`,
    `</script>`,
  ].join('\n');
}
