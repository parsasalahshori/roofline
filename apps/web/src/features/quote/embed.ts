/*
 * Embedding the instant quote page on a company's own website. The page runs inside an iframe there; it tells the
 * parent its height whenever it changes, and the snippet's small script resizes the iframe. The message carries
 * only a number, so any parent may read it.
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
    `<iframe id="${id}" src="${pageUrl}" title="${title.replace(/"/g, '&quot;')}" style="width:100%;border:0;height:640px" loading="lazy" allow="clipboard-write"></iframe>`,
    `<script>`,
    `window.addEventListener("message", function (e) {`,
    `  if (e.origin !== "${origin}" || !e.data || e.data.type !== "${RESIZE_MESSAGE}") return;`,
    `  var f = document.getElementById("${id}");`,
    `  if (f) f.style.height = Math.max(400, Math.min(4000, Number(e.data.height) || 0)) + "px";`,
    `});`,
    `</script>`,
  ].join('\n');
}
