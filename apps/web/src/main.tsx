import '@roofline/ui/tokens.css';
import '@roofline/ui/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { common } from './copy/common.ts';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

// A placeholder: the router replaces it (Task 10).
createRoot(root).render(
  <StrictMode>
    <p>{common.appName}</p>
  </StrictMode>,
);
