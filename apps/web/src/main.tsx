import '@fontsource-variable/archivo/wdth.css';
import '@roofline/ui/tokens.css';
import '@roofline/ui/base.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

// The public instant quote page (/q/:slug) is its own small bundle: no app shell, router, map or tile session.
// Everything else loads the app (boot.tsx). The slug is the only thing read from the address.
// Each start lives in its own async function on purpose: written as an if/else of two `import().then()` calls, the
// production build merged them into one preload call carrying only the quote page's files, so every app page loaded
// without the app's stylesheet (boot-*.css). apps/web/scripts/check-build-preload.mjs checks the built output on every build.
async function startQuotePage(host: HTMLElement, slug: string): Promise<void> {
  const quote = await import('./features/quote/entry.tsx');
  quote.mountQuotePage(host, slug);
}

async function startApp(host: HTMLElement): Promise<void> {
  const app = await import('./app/boot.tsx');
  app.bootApp(host);
}

const quoteSlug = /^\/q\/([a-z0-9-]{3,40})\/?$/i.exec(window.location.pathname)?.[1];
if (quoteSlug !== undefined) void startQuotePage(root, quoteSlug.toLowerCase());
else void startApp(root);
