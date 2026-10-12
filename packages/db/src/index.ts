export { decrypt, encrypt } from './crypto.ts';
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
export {
  type ActorType,
  type AgentEventKind,
  type AgentEventRow,
  insertAgentEvent,
  listRecentEvents,
  listTaskEvents,
  type NewAgentEvent,
} from './repos/agent-events.ts';
export {
  type AgentCounts,
  agentCounts,
  type AgentSettingsInfo,
  agentSettingsInfo,
  breakdownByBaseline,
  dailyFinished,
  type MetricsWindow,
  minutesByAgent,
  type RecentTaskRow,
  recentTasks,
  taskSubjectScope,
} from './repos/agent-metrics.ts';
export { type FeedCursor, type FeedRow, listFeedPage } from './repos/agent-feed.ts';
export { listWaitingTasks, type WaitingTaskRow } from './repos/agent-waiting.ts';
export { audit, type AuditEntry } from './repos/audit.ts';
export {
  insertTimeRecount,
  listRecountSteps,
  loadBaselineOverrides,
  refreshTaskMinutes,
  type RecountStep,
  rewriteStepSnapshot,
  setBaselineOverrides,
} from './repos/time-baselines.ts';
export * from './repos/agent-settings.ts';
export { insertDefaultSettings, pickFreeSlug, setServiceArea, slugify } from './repos/companies.ts';
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
  companyContact,
  customersWithPhone,
  type DeliveryOutcome,
  flagPossibleOptOut,
  type InboundText,
  insertInboundText,
  lockRecipients,
  type PhoneCustomer,
  POSSIBLE_OPT_OUT,
  recordDeliveryOutcome,
  restoreConsentByText,
  revokeConsentByText,
  TEXTED_START,
  TEXTED_STOP,
} from './repos/inbound.ts';
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
  StageRuleError,
  updateJob,
} from './repos/jobs.ts';
export { type CompanyLocation, companyLocation } from './repos/location.ts';
export {
  getStepText,
  insertStepText,
  isOptedOut,
  lockNextDueText,
  lockRecipient,
  markTextFailed,
  markTextSent,
  markUnconfirmedTexts,
  type MessageRow,
  type OutboundText,
  recordSmsUsage,
  rewriteRetryableText,
  type StepTextCounts,
  type StepTextState,
  stepTextCounts,
  textHistory,
  type TextHistory,
  textingCompanyFacts,
  type TextingCompanyFacts,
  textingRecipientFacts,
  type TextingRecipientFacts,
  type TextState,
  updateScheduledText,
} from './repos/messages.ts';
export {
  type Bbox,
  type CustomerPin,
  type GeoJsonMultiPolygon,
  type JobPin,
  mapArea,
  mapPins,
  type PinCluster,
  type PinLayer,
  type PinsResult,
  SERVER_CLUSTER_ABOVE,
} from './repos/map.ts';
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
export { type SearchAddress, searchAll, type SearchCustomer, type SearchJob } from './repos/search.ts';
export {
  claimStep,
  countWorkingTasks,
  customerFirstNames,
  expireOverdueDrafts,
  findRerunOf,
  finishClaimedStep,
  finishParkedStep,
  getCompanyName,
  getStep,
  getTask,
  insertTask,
  listParkedSteps,
  listSteps,
  listTasks,
  listTasksByStatus,
  type ListTasksOptions,
  moveStep,
  type NewStepRow,
  type NewTaskRow,
  reclaimExpiredLeases,
  renewStepLease,
  requeueForRetry,
  setStepSnapshot,
  type StepEdit,
  type StepFinish,
  type StepMove,
  type StepRow,
  type StepSnapshot,
  type StepSummaryRow,
  sumStepMinutesSaved,
  type TaskRow,
  type TaskUpdate,
  updatePendingStep,
  updateTask,
} from './repos/tasks.ts';
// F3 skeleton (Task 1): one line per new repo file; later F3 tasks fill the files in.
export * from './repos/setup.ts';
export * from './repos/imports.ts';
export * from './repos/import-apply.ts';
export * from './repos/usage.ts';
export * from './repos/billing.ts';
export * from './repos/company-location.ts';
export * from './repos/opt-outs.ts';
export * from './repos/delivery.ts';
export type { LngLat } from './schema/columns.ts';
export * from './schema/index.ts';
export { type TenantContext, type Tx, withTenant } from './tenant.ts';
// C1 skeleton (Task 1): one line per new repo file; later C1 tasks fill the files in.
export * from './repos/board.ts';
export * from './repos/timeline.ts';
export * from './repos/notes.ts';
export * from './repos/customer-view.ts'; // C1 Task 7
export * from './repos/appointments.ts';
export * from './repos/today.ts';
export * from './repos/schedules.ts';
export * from './repos/calendar.ts';
export * from './repos/calendar-links.ts';
export * from './repos/calendar-busy.ts';
export * from './repos/quotes.ts';
export * from './repos/pricebook.ts';
export * from './repos/export.ts';
// D1 skeleton (Task 1): one line per new repo file; later D1 tasks fill the files in.
export * from './repos/conversations.ts';
export * from './repos/turns.ts';
export * from './repos/calls.ts';
export * from './repos/claim-intakes.ts';
export * from './repos/front-desk-settings.ts';
export * from './repos/blocked-numbers.ts';
export * from './repos/fd-booking.ts';
export * from './repos/fd-caller.ts';
export * from './repos/follow-up-log.ts';
// G1 Claims (Task 6)
export * from './repos/claims.ts';
// G1 Task 10
export * from './repos/scheduler.ts';
export * from './repos/scheduler-agenda.ts';
// G1 Task 8
export * from './repos/claims-agent.ts';
