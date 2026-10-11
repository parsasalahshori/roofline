# Merge notes, sibling 2 (F3 Tasks 3, 4, 5; Opus contact 31, run wf_13479391-707)

Branches (base f3-setup d629c74), Platform job green on each head:

| Task | Branch | Head | CI run |
|---|---|---|---|
| 3 billing config and metering | f3-t3 | b857c5d | 38180141961 |
| 4 setup checklist rules | f3-t4 | 18a3eef | 38179479139 |
| 5 texting registration details | f3-t5 | 2dd3312 | 38179525445 |

(The v1 node:test job fails on all three because the old base carries the empty v1 data file; known, fixed on f2-shell in 0b81e1b.)

## Group check merge notes

I found no blocking problems, and none of the three branches edit the same file, so I predict no merge conflicts. I did not run typecheck or tests on the merged result.

Files each branch changes (base d629c74):
- **T3:** config/billing-plans.example.json (new), packages/db/src/schema/enums.ts, packages/shared/src/billing.ts, packages/shared/test/billing.test.ts (new).
- **T4:** packages/shared/src/setup.ts, packages/shared/test/setup.test.ts (new).
- **T5:** packages/shared/src/address.ts, packages/shared/src/texting.ts, packages/shared/src/texting-campaign.ts (new), packages/shared/test/address.test.ts, packages/shared/test/texting.test.ts (new).

`git merge-tree` of f3-t3 with f3-t4 merged cleanly. T5 has no files in common with either, so it also applies cleanly. Merge in any order (for example T3, then T4, then T5) with no conflict handling.

How they fit together:
- packages/shared/src/index.ts already re-exports setup.ts, billing.ts and texting.ts in the base, so no branch needed to edit it.
- None of the new exported names collide with each other or with existing exports. I checked METERS, Meter, INVOICE_KINDS, METER_EVENT_NAME, PlanConfig, BillingConfig, BillingConfigError, PlanSummary, BillingView, USAGE_KINDS, UsageKind, COMING_WITH, ComingWith, FOUNDATION_ITEMS, SKIPPABLE, SetupFacts, SetupItemView, SetupView, deriveSetup, BUSINESS_TYPES, BRAND_FIELDS, BrandField, BrandInfo, BrandInfoSchema, CampaignInfo, USE_CASE_LABEL, displayUsPhone, buildCampaign, plainRejection, TEXTING_STATES, TextingState, TextingView, US_STATE_NAMES and toUsStateCode.
- T3 moves USAGE_KINDS and UsageKind into shared and re-exports them from packages/db/src/schema/enums.ts. Its existing users (db schema/tenant.ts and repos/usage.ts) still import from ./enums.ts, so they keep working.
- T4 uses CampaignStatus ('none' | 'pending' | 'approved' | 'rejected') and T3 uses CompanyStatus; both already exist in shared enums.ts.
- T3 and T5 both use zod, which @roofline/shared already depends on (^4.1.0).

Copy and lint rules: nothing here touches the web app or JSX. The shared `as const` arrays add new snake_case values (texting_registration_fee, phone_number_month, non_profit, front_desk, storm_scout, not_started, needs_fix, and others) to the banned-copy-word list. Later web tasks must not use those as literal words in copy.

Interfaces match the briefs exactly, except for T5's extra helpers described in the issues.

After merging, run on the integration branch: `npx vitest run --project @roofline/shared` (focused, no wrapper needed) and `/home/user/roofline/ops/bin/slot npm run typecheck`. Leave the @roofline/db tests to CI.

## Group check issues (all minor, none blocking)

- **T4, T5** (minor): T4's SetupFacts.texting.rejectedFields is typed string[] (as the brief says), while T5 produces BrandField[] (plainRejection().fields, TextingView.rejectedFields). It compiles, because BrandField[] can be assigned to string[]. But the setup item's data.fields loses the field-name typing, and Task 16/32 consumers could hand the web anything. Suggestion: No change is needed before merging. If you want it tighter, change SetupFacts.texting.rejectedFields to BrandField[] after T5 lands (import type { BrandField } from './texting.ts'). setup.ts would then depend on texting.ts, and that dependency has no cycle.
- **T5** (minor): T5 went beyond its brief's file list. It added packages/shared/src/texting-campaign.ts (re-exported from texting.ts with export *) and extended address.ts with US_STATE_NAMES and toUsStateCode. It also exports displayUsPhone from texting-campaign.ts. Later tasks need the same US phone display (Task 10 HELP text, Task 22/28 'Texting number (402) 555-0100' descriptions, Task 35 web) and state normalisation (Task 7 import rows). Those tasks may write their own copies if they don't know these helpers exist. Suggestion: Keep it as built; nothing here conflicts. Tell the builders of Tasks 7, 10, 22, 28 and 35 to import toUsStateCode and displayUsPhone from @roofline/shared rather than write new ones. Later, displayUsPhone could move to phone.ts, but that is optional.
- **T5** (minor): In BrandInfoSchema the state field runs regex /^[A-Za-z]{2}$/ before toUsStateCode, so the full-name branch of toUsStateCode can never run from the schema. 'Nebraska' gets the state message, which is what the brief's test requires, and 'NE.' is also rejected even though the helper accepts it. This is consistent with the brief, but it can mislead anyone who reuses the helper and assumes the schema accepts names. Suggestion: No change for this merge. Write a note for Task 7 that toUsStateCode accepts full names, which suits import files, and that the brand form deliberately does not.
- **T3** (minor): The T3 'no hard-coded prices' test walks every apps/*/src and packages/*/src file looking for 19900 or 39900. Any later branch that puts one of those numbers in a fixture, a seed or an unrelated constant under src fails @roofline/shared tests, far from the change that caused it. Nothing in T4 or T5 trips it today (checked). Suggestion: No action for this merge. Tell later builders (Tasks 18, 19, 33) to read prices from config and keep the example numbers out of src.
