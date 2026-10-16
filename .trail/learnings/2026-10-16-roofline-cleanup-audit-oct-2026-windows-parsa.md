---
title: "Roofline cleanup audit Oct 2026: windows, quote page, gutters, photo, iPhone"
author: Parsa
date: 2026-10-16
branch: cleanup/misc
cost: { minutes: 58, tokens: 237003 }
touches:
  - apps/web/src/copy/factoryOrders.ts
  - apps/web/src/features/settings/FactoryOrdersSection.module.css
  - apps/web/src/features/settings/FactoryOrdersSection.tsx
  - apps/web/src/features/settings/PricesTab.tsx
  - apps/web/src/features/settings/window-order-settings-api.ts
  - apps/web/test/c1-routes.test.tsx
  - apps/web/test/e1-routes.test.tsx
  - apps/web/test/settings-factory-orders.test.tsx
  - apps/web/test/settings-prices.test.tsx
  - apps/api/src/providers/static-map.ts
---

## Decided
- Gutters: removed from homeowner instant quotes; staff tool stays as a draft. Vs 34 EagleView reports gutter length is median ~28-30% short because the roof engine labels outer eaves as rakes and misses upper-floor eaves; the gutter code itself is ~3.6% off when fed EagleView's faces.
- Street View window marking, wall line-up and door ruler: hidden behind a flag (usable on 3/15 houses; sizes swung 2x with rep input). The wall-based window estimate stays but needs real floor counts and garage exclusion.
- Instant quote: gate prices on the roof's own review flags, building size, unit/apartment addresses; otherwise show the "We'll call you" screen. Booking stays off for multi-market clients until visits are routed by market.
- iPhone: native SwiftUI + ARKit + RoomPlan app in apps/ios (XcodeGen). It sends the same 'ar' scale as Android WebXR plus device/cornerSpreadM; RoomPlan windows are quote-only and may have no photo. AR corners are ordered by gravity on the server.
- AR uncertainty adds a 1% scale term, so most AR windows are 'check' on orders until a steel-tape field test calibrates it.

## Tried and ruled out
- No post-hoc gutter formula (perimeter x k, minus rakes, sqrt(area), regressions) gets above ~47% of houses within ±15%; only better eave geometry or EagleView eave length can.
- Capacitor/web-wrapper iPhone app: AR UI must be native anyway, and a thin wrapper risks App Store guideline 4.2.

## Watch out
- apps/api/src/estimator/windows-heights.ts EAVE_PERCENTILE=0.1 picks the lowest eave (porch/garage): every 2-storey house reads as 1 floor.
- apps/api/src/providers/street-view.ts pano-id regex rejects user-uploaded pano ids containing '.', giving a false "no street-level photo"; the error is not logged.
- The photo engine's proposeQuad was never implemented although the UI promised auto corners; scripts/test/window-photo-bench.test.ts was failing (0.3077 < 0.3).
- Command Line Tools here are Swift 5.8.1 with no PackageDescription/XCTest: check the iPhone core with apps/ios/Core/scripts/check.sh. Installing Xcode via `mas` needs sudo.
- ~/roofline-demo auto-pushes real-lookups every 3 minutes (com.roofline.autosync): do work in worktrees and only commit finished work there.
