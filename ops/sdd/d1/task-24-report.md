# Task 24 report: forwarding guide and test

Built (web only):
- A-guide: ForwardingGuide.tsx/.module.css (carrier and mode pickers, codes from forwardingSteps() as data with copy Button, steps as OL), mounted in FrontDeskTab.tsx slot.
- B-test: ForwardingTest.tsx/.module.css, forwarding-api.ts (POST start, poll every 2 s while calling), invalidates front-desk settings on verified.
- C-setup: phone_number SetupRow now has a primary action linking to /settings/front-desk#forwarding (copy setup.actions.forwardCalls); setup tests updated.
- Tests: d1-t24-guide, d1-t24-test, d1-t24-setup; d1-t23 and d1-settings tests updated for the mounted guide (GET /api/texting stub, slot assertion).

Review round 1: verify failed, 4 findings; contact check F1 approve, F2/F3/F4 amend; fixed. Review round 2: verify passed, 0 findings.

Minors / contract notes:
- No dedicated Roofline-number field; number comes from useTexting().data.number; business number is CompanyBody.phone. No endpoint invented.
- Banner has no success tone; verified uses info.
- ForwardingTest hidden when no Roofline number exists.
- packages/shared COMING_WITH still maps phone_number to front_desk; drop later.

Verify tail: typecheck, lint, lint:css clean; web vitest 59 files, 546 tests passed.
