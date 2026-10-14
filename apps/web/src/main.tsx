import '@fontsource-variable/archivo/wdth.css';
import '@roofline/ui/tokens.css';
import '@roofline/ui/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { Providers } from './app/providers.tsx';
import { createAppRouter } from './app/router.tsx';
// Starts the Google satellite tile session at load, so the roof view has it ready when it opens.
import './features/measure/lift/googleTiles.ts';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

const router = createAppRouter();

createRoot(root).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
