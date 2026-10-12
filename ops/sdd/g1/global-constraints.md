## Global Constraints (G1 Claims, Scheduler and Follow-up agents)

Adapted from the earlier milestones' constraints (`ops/sdd/{c1,e1,s1,d1,a1}/global-constraints.md`, which carry F1–F3's rules) and the plan (`docs/superpowers/plans/2026-10-12-roofline-more-agents.md`). Spec: `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Branch `g1-agents` from `a1-agents` once A1 is merged; task branches `g1-t<N>`. Rulings use the prefix **GX-** (F2 already used plain letters).

**Upstream milestones are not built yet.** Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** in a brief come from their plans and briefs; the lead checks each against the merged branch before starting and records any difference.

**Everything in the upstream global constraints applies**, with these changes:
- **Migrations:** G1 owns `0022`/`0023` (Task 1). A1 ends at `0021`.
- **No new dependencies.**
- **Claude (D1 Ruling DA):** only through D1's `Llm` seam and the Anthropic TypeScript SDK; `claude-opus-5-5` drafts texts, `claude-haiku-5-5` extracts claim replies; tests use `ScriptedLlm`; no live call in CI; `eval:agent-texts` is manual.
- **Every customer text is a draft** approved in R2; staff notices and claim-fact updates from replies are the only automatic actions.

**From the plan (verbatim):**
- Everything in the earlier milestones' Global Constraints applies.
- **Customer texts only via `send_personal_texts` steps in approved tasks**, through the gate; the only automatic outbound items are staff agenda emails, rep nudges and Front Desk's "Thanks, got it." reply (D1 path).
- **Every drafted text passes D1's guards plus the claims guard list** before it is stored in a payload, and again at send time.
- **No code path addresses an insurer or adjuster** (no adjuster phone/email used as a recipient; a test greps the send paths).
- **Limits live in one shared function** (`followUpAllowed`) used by all three agents.
- **Lockfile:** untouched. **Migrations:** only Task 1 (`0022` generated, `0023` custom).

## Review Focus


1. **Stop conditions and spacing** (Decisions 7, 8): replies, signatures, bookings, Lost; per-customer and cross-agent limits. (Tasks 2, 13)
2. **Claims boundaries** (Decision 4): no coverage/deductible language; no insurer contact. (Tasks 2, 8)
3. **Consent:** reminders/nudges informational; review requests marketing only. (Tasks 5, 14)
4. **Weather moves:** proposals only, crew availability respected, customers told only after approval. (Task 11)
