// Type-only: brings global-setup.ts's `ProvidedContext` augmentation into every program that imports
// this entry point, so `inject('dbUrls')` type-checks in other packages' tests. Erased at runtime,
// so importing @roofline/db/testing never loads Testcontainers.
import type {} from './global-setup.ts';

export { startTestDatabase, TEST_ROLE_PASSWORDS, type TestDatabase } from './database.ts';
export { resetDb } from './reset.ts';
export {
  SEED_PASSWORD,
  hashPassword,
  seedCompany,
  seedTwoCompanies,
  type SeedCompanySpec,
  type SeedCompanyUser,
  type SeededCompany,
  type SeededCompanyBase,
  type SeededMember,
  type SeedUser,
} from './seed.ts';
export * from './storms.ts';
