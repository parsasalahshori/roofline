# Task 25 report: plan review previews and Edit for the new steps

## Built
- P1-email: EmailBatchPreview (+ emailBatchKit), copy/stepEmail.ts, step-email test.
- P2-routes-and-sheet: BuildRoutesPreview, generic StepFieldsSheet, Review.tsx wiring (kit preview details block, shared sendEdit), copy/stepRoutes.ts and stepEdit.ts, tests.
- P3-ads-and-wiring: AdCampaignPreview (approved maximum and floored daily amount), SwathThumb (hail swath thumbnail; replaced CircleThumb after review 1), copy/stepAds.ts, steps registry wiring in toReviewStep.ts and editable.ts, tests. Edit may lower but never raise maxSpendCents.

## Reviews
- Review 1: 3 findings. F1 amended, F2 approved, F3 approved.
- Review 2: 0 findings.

## Minors / deviations
- stepAds platform names are 'Search ads' / 'Social media ads' because the vendor-word copy-rules test forbids vendor names in stepAds.ts.
- Server strict createAdPayload has no circles/photos keys; they are read defensively and render nothing when absent. If the server later stores them, toPayload must drop them or the schema must allow them.
- Brief's `--project web` test command does not work; use `--project @roofline/web`.

## Verify tail
typecheck, lint, lint:css clean. vitest @roofline/web: 61 files, 580 tests passed.
