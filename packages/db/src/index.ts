export { findPgError, isUniqueViolation, type PgErrorInfo } from './errors.ts';
export { MIGRATIONS_FOLDER, migrate } from './migrate.ts';
export { createPools, type Db, type PoolName, type PoolOptions, type Pools, type Schema } from './pools.ts';
export {
  addActivity,
  type ActivityEntry,
  type ActivityRow,
  listActivities,
  type ListActivitiesOptions,
} from './repos/activities.ts';
export { audit, type AuditEntry } from './repos/audit.ts';
export { insertDefaultSettings, pickFreeSlug, slugify } from './repos/companies.ts';
export {
  CONSENT_LABELS,
  createCustomer,
  type CustomerInput,
  type CustomerPatch,
  type CustomerRow,
  DuplicatePhoneError,
  ensureOptOuts,
  getCustomer,
  listCustomers,
  type ListCustomersOptions,
  setArchived,
  updateCustomer,
  type WriteOptions,
} from './repos/customers.ts';
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './repos/paging.ts';
export * from './schema/index.ts';
export { type TenantContext, type Tx, withTenant } from './tenant.ts';
