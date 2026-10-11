export { findPgError, ForbiddenError, isUniqueViolation, type PgErrorInfo } from './errors.ts';
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
export {
  createJob,
  getJob,
  type JobInput,
  JobLinkError,
  jobLinkErrorFromPg,
  type JobLinkProblem,
  type JobPatch,
  type JobRow,
  listJobs,
  type ListJobsOptions,
  setJobArchived,
  updateJob,
} from './repos/jobs.ts';
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './repos/paging.ts';
export {
  AddressHasJobsError,
  AddressNeedsCustomerError,
  createProperty,
  CustomerRequiredError,
  DuplicateAddressError,
  getProperty,
  linkPropertyToCustomer,
  listProperties,
  type ListPropertiesOptions,
  type PropertyInput,
  type PropertyPatch,
  type PropertyRow,
  setPropertyArchived,
  UnknownCustomerError,
  updateProperty,
} from './repos/properties.ts';
export { canSeeJobValue, customerScope, jobScope, propertyScope } from './repos/scope.ts';
export {
  claimStep,
  countWorkingTasks,
  customerFirstNames,
  expireOverdueDrafts,
  findRerunOf,
  finishClaimedStep,
  getCompanyName,
  getStep,
  getTask,
  insertTask,
  listSteps,
  listTasks,
  listTasksByStatus,
  type ListTasksOptions,
  moveStep,
  type NewStepRow,
  type NewTaskRow,
  reclaimExpiredLeases,
  requeueForRetry,
  type StepEdit,
  type StepFinish,
  type StepMove,
  type StepRow,
  type StepSummaryRow,
  type TaskRow,
  type TaskUpdate,
  updatePendingStep,
  updateTask,
} from './repos/tasks.ts';
export type { LngLat } from './schema/columns.ts';
export * from './schema/index.ts';
export { type TenantContext, type Tx, withTenant } from './tenant.ts';
