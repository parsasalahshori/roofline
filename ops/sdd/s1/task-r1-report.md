# Task R1 report: hail day boundaries

Built: P1 (mesh/source/units/run/main/README: 60min MESH accumulation, one final 12Z close per convective day), P2 (storms/writer: overlap-component merge, union writer, merged storms keep the oldest id), P3 (storms.merged_into in 0018 section 10, snapshot, global.ts, merged_into filters in company-storms, storm-layer, storm-match-fanout; rls and storm-merged tests).

Reviews: Review 1 verify passed, 1 finding, amended after contact check (F1=amend). Review 2 verify passed, 0 findings.

Minors: storm-api.ts list/summary queries still need `merged_into is null` (R2a owns it; lead to apply). A merged storm's own storm_contours rows remain. Union-test 8% band unconfirmed until CI.

Verify: syntax ok; typecheck clean; lint clean; drizzle-kit: "No schema changes, nothing to migrate".
