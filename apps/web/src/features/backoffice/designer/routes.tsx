import type { RouteObject } from 'react-router';
import { Visualizer } from '../visualizer/Visualizer.tsx';
import { QuoteEditor } from './QuoteEditor.tsx';

/**
 * The designer's routes, absolute so the integrator can place them under the back-office shell:
 * the quote editor, and the house-photo visualizer for the same quote.
 */
export const designerRoutes: RouteObject[] = [
  { path: '/backoffice/quotes/:quoteId', element: <QuoteEditor /> },
  { path: '/backoffice/quotes/:quoteId/visual', element: <Visualizer /> },
];
