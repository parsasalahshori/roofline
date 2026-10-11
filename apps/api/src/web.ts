import path from 'node:path';
import express, { type Express, type RequestHandler } from 'express';

/**
 * Serves the built web app (apps/web/dist) from the API's own process, so production and the
 * end-to-end stack are one origin: no CORS, and the session cookie and the Origin check just work.
 * Mounted after every API route and before the 404 handler (app.ts), and only when
 * `config.WEB_DIST_DIR` is set.
 *
 * - Built files are served as they are. Everything under `/assets/` has a hash in its name, so it
 *   is cached for a year and marked immutable. `index.html` is never cached, so a new deploy is
 *   picked up on the next load; its ETag still lets the browser skip the download.
 * - Any other GET or HEAD for something that is not a file is a page of the app (`/approvals/abc`,
 *   `/jobs`): it gets `index.html` and the app's own router takes over.
 * - The fallback never answers `/api/*`, `/hooks/*` or `/health` (those keep their JSON answers,
 *   including the JSON 404), and never a path that looks like a file (`/assets/missing.js`): a
 *   script that is not there must be a 404, not a web page the browser then fails to run.
 */

/** `/api`, `/hooks` or `/health` as a whole first segment, in any letter case (Express matches routes that way too). */
const NOT_A_PAGE = /^\/(?:api|hooks|health)(?:\/|$)/i;

/** A last segment with an extension: `/assets/app.js`, `/logo.png`, `/robots.txt`. */
const LOOKS_LIKE_FILE = /\.[a-z0-9]+$/i;

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

export function serveWeb(app: Express, distDir: string): void {
  const root = path.resolve(distDir);
  const indexPath = path.join(root, 'index.html');
  const assetsPrefix = path.join(root, 'assets') + path.sep;

  app.use(
    express.static(root, {
      // `/` is the fallback's to answer, so it gets the same headers as every other page.
      index: false,
      setHeaders(res, filePath) {
        if (filePath.startsWith(assetsPrefix)) res.setHeader('Cache-Control', IMMUTABLE);
        else if (filePath === indexPath) res.setHeader('Cache-Control', NO_CACHE);
      },
    }),
  );

  const page: RequestHandler = (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || NOT_A_PAGE.test(req.path) || LOOKS_LIKE_FILE.test(req.path)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', NO_CACHE);
    res.sendFile(indexPath, (err) => {
      // A browser that went away mid-download is not worth an error; anything else (index.html
      // deleted under a running server) goes to the error handler and is logged.
      if (err && !res.headersSent) next(err);
    });
  };
  app.use(page);
}
