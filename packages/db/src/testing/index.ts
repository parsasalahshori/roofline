// Type-only: brings global-setup.ts's `ProvidedContext` augmentation into every program that imports
// this entry point, so `inject('dbUrls')` type-checks in other packages' tests. Erased at runtime,
// so importing @roofline/db/testing never loads Testcontainers.
import type {} from './global-setup.ts';

export { resetDb } from './reset.ts';
export {
  SEED_PASSWORD,
  hashPassword,
  seedTwoCompanies,
  type SeedUser,
  type SeededCompany,
} from './seed.ts';
