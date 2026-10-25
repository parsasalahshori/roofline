import type { ProductCatalog } from '@roofline/shared';
import type { CatalogErrors } from './catalog.ts';

/** The price book being edited, how to change it, and what is wrong with it. Passed to every section. */
export type Draft = {
  catalog: ProductCatalog;
  change: (edit: (catalog: ProductCatalog) => ProductCatalog) => void;
  errors: CatalogErrors;
};
