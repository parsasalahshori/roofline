import '@fontsource-variable/archivo/wdth.css';
import '@roofline/ui/tokens.css';
import '@roofline/ui/base.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

// The public instant quote page (/q/:slug) is its own small bundle: no app shell, router, map or tile session.
// Everything else loads the app (boot.tsx). The slug is the only thing read from the address.
const quoteSlug = /^\/q\/([a-z0-9-]{3,40})\/?$/i.exec(window.location.pathname)?.[1];
if (quoteSlug !== undefined) {
  void import('./features/quote/entry.tsx').then((m) => m.mountQuotePage(root, quoteSlug.toLowerCase()));
} else {
  void import('./app/boot.tsx').then((m) => m.bootApp(root));
}
