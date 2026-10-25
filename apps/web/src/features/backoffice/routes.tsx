import type { RouteObject } from 'react-router';
import { HomePage } from './home/HomePage.tsx';
import { OrderPage } from './orders/OrderPage.tsx';
import { OrdersPage } from './orders/OrdersPage.tsx';
import { ProductsPage } from './products/ProductsPage.tsx';
import { SettingsPage } from './settings/SettingsPage.tsx';

/**
 * The back office routes, for the shell's children in app/router.tsx. The quote designer and the visualizer
 * (/backoffice/quotes/:quoteId and .../visual) come from ./designer/routes.tsx and are added here when that branch merges.
 */
export const backofficeRoutes: RouteObject[] = [
  { path: 'backoffice', element: <HomePage /> },
  { path: 'backoffice/products', element: <ProductsPage /> },
  { path: 'backoffice/orders', element: <OrdersPage /> },
  { path: 'backoffice/orders/:orderId', element: <OrderPage /> },
  { path: 'backoffice/settings', element: <SettingsPage /> },
];
