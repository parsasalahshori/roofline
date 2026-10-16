import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { reportHeight } from './embed.ts';
import { QuotePage } from './QuotePage.tsx';

/**
 * Mounts the public instant quote page alone (main.tsx loads this chunk for /q/:slug instead of the app): no router,
 * no session, no map, no React Query. Inside a company's iframe it reports its height so the frame fits it.
 */
export function mountQuotePage(root: HTMLElement, slug: string): void {
  createRoot(root).render(
    <StrictMode>
      <QuotePage slug={slug} />
    </StrictMode>,
  );
  reportHeight();
}
