import '@roofline/ui/tokens.css';
import '@roofline/ui/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { Providers } from './app/providers.tsx';
import { createAppRouter } from './app/router.tsx';

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
