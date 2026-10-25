import type { RouteObject } from 'react-router';
import { BackofficeGuard } from './BackofficeGuard.tsx';
import { designerRoutes } from './designer/routes.tsx';
import { HomePage } from './home/HomePage.tsx';
import { OrderPage } from './orders/OrderPage.tsx';
import { OrdersPage } from './orders/OrdersPage.tsx';
import { ProductsPage } from './products/ProductsPage.tsx';
import { SettingsPage } from './settings/SettingsPage.tsx';

/**
 * The back office routes, for the shell's children in app/router.tsx, including the quote designer and the visualizer
 * from ./designer/routes.tsx (made relative like the rest, and behind the same access check).
 */
export const backofficeRoutes: RouteObject[] = [
  { path: 'backoffice', element: <HomePage /> },
  { path: 'backoffice/products', element: <ProductsPage /> },
  { path: 'backoffice/orders', element: <OrdersPage /> },
  { path: 'backoffice/orders/:orderId', element: <OrderPage /> },
  { path: 'backoffice/settings', element: <SettingsPage /> },
  ...designerRoutes.map((r) => ({ ...r, path: r.path?.replace(/^\//, ''), element: <BackofficeGuard>{r.element}</BackofficeGuard> })),
];
