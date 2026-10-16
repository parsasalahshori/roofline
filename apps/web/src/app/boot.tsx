import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { Providers } from './providers.tsx';
import { createAppRouter } from './router.tsx';
// Starts the Google satellite tile session at load, so the roof view has it ready when it opens.
import '../features/measure/lift/googleTiles.ts';

/** The signed-in app (and its public sign-in and proposal pages): the router under the providers. */
export function bootApp(root: HTMLElement): void {
  const router = createAppRouter();
  createRoot(root).render(
    <StrictMode>
      <Providers>
        <RouterProvider router={router} />
      </Providers>
    </StrictMode>,
  );
}
