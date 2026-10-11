# Research and implementation decisions

Researched October 6, 2026. Primary sources below; no code copied from the unlicensed example projects.

## Existing GitHub attempts

| Repository | What it attempts | Decision |
|---|---|---|
| [AIBuilderDay/JobNimbus](https://github.com/AIBuilderDay/JobNimbus) | A roofing-estimate hackathon plan combining address lookup, Google Solar geometry, 3D presentation and a CRM handoff. Its published plan explicitly includes simulated background verification. | Useful workflow reference; do not represent simulated verification as real. Google Solar restriction prevents using that path for ordinary roof-only quoting. No repository license detected in GitHub metadata. |
| [Solar-Roof-Measurement-Calaculator](https://github.com/kushagrachopra18/Solar-Roof-Measurement-Calaculator) | Next.js/TypeScript Google Maps project. Users trace roof panels; a packing algorithm estimates solar-panel capacity. The README warns that its deployed demo may no longer work after its Google trial. | Useful manual-tracing example, not automatic roof measurement. No repository license detected in GitHub metadata; inspected documentation only. |
| [BuildCLI/BuildCLI](https://github.com/BuildCLI/BuildCLI) | Java project automation CLI with Picocli commands and PF4J command-plugin support. | Actually built and used. Pinned revision `471f8e7d9d02a42154f26a6aa423858c19720ca8` (2026-09-29). Generated the roof plugin scaffold using `plugin init`; compiled custom API commands and verified real plugin loading. MIT notice preserved in `cli/BUILDCLI-LICENSE`. |

## Data-provider findings

**Google Maps.** Geocoding can identify address candidates; Static Maps supplies satellite imagery. Neither is a roof measurement. Results may be approximate or point to a neighboring building. Roofline requires candidate selection, retains Google attribution, and uses an authenticated, no-store image proxy. Geocoded coordinates remain in browser state rather than being written to SQLite. [Geocoding documentation](https://developers.google.com/maps/documentation/geocoding/overview), [Static Maps](https://developers.google.com/maps/documentation/maps-static/overview).

**Google Solar.** Building Insights exposes roof area and pitch, so it initially appeared attractive. However, Section 20.1 of the current service terms restricts use to energy-system feasibility, design/installation and defined downstream transactions. Ordinary roof-only replacement estimating is not one of the listed uses. Roofline does not implement this connector. Any future energy-system workflow must review permitted use, attribution and storage requirements. [Building Insights](https://developers.google.com/maps/documentation/solar/building-insights), [Service-specific terms, §20](https://cloud.google.com/maps-platform/terms/maps-service-terms), [Solar policies](https://developers.google.com/maps/documentation/solar/policies).

**EagleView.** Its measurement APIs are explicitly intended for property measurement/report workflows. This implementation targets the documented legacy WebServices contract: `POST /v2/Order/PriceOrder`, `POST /v2/Order/PlaceOrder`, and `GET /v3/Report/GetReport?reportId=…`. Requests use a bearer token and account-provided entitlement. No real token was available. New developer-portal API credentials are not necessarily interchangeable with the legacy API; use the correct account/API or adapt against the contracted API. [Measurement Orders overview](https://developer.eagleview.com/user-guides/developer-guides/measurement-orders-api), [legacy REST reference](https://restdoc.eagleview.com/), [v3 report contract](https://restdoc.eagleview.com/json/v3getreport.json), [ordering contract](https://restdoc.eagleview.com/json/placeorder.json).

**RentCast.** The documented `/v1/properties?address=…` endpoint supports full-address records with `X-Api-Key` authentication. Roofline exposes a small subset for optional context. Building living area is shown as living area and never passed into roofing calculations. [Property search documentation](https://developers.rentcast.io/reference/search-queries).

**Zillow.** Zillow's developer portal lists multiple data products and access paths. Listing information alone does not establish roof surface area or geometry. Roofline does not scrape Zillow, infer roof size from living area, or claim an unauthenticated Zillow measurement connector. [Zillow developer portal](https://www.zillowgroup.com/developers/).

## Chosen architecture

Use licensed roof measurements plus a deterministic pricing engine. Keep demo/manual/import workflows functional without account credentials. Do not use a language model to invent roof geometry, damage, confidence percentages or regional prices. Automatic provider orders create reviewable drafts, with idempotency and no automatic retry after an uncertain paid-order outcome. The original application code is new; BuildCLI plugin scaffolding is the only reused upstream implementation.
