# Connector setup

All credentials are server environment variables. Restart the server after changing them. The Integrations screen reports key presence, not successful account verification.

## Google Maps

Set `GOOGLE_MAPS_API_KEY`. Enable **Geocoding API** and **Maps Static API** on the billed Google Cloud project. Restrict the key to those APIs and appropriate server IPs. Address lookup supports US addresses and returns up to five candidates. Choose the correct building. A partial/non-rooftop result is explicitly labeled approximate. Images and coordinate responses use `Cache-Control: no-store`; no map image is persisted.

The app cannot measure an arbitrary roof from a Google screenshot. After lookup, enter measured roof geometry or retrieve a report. Verify addresses in the provider's map and observe Google attribution/terms requirements for your deployment.

## EagleView legacy WebServices

Set `EAGLEVIEW_ACCESS_TOKEN` from a compatible licensed WebServices account, and `EAGLEVIEW_ENV=sandbox` or `production`. Fixed hosts are `https://webservices-integrations.eagleview.com` and `https://webservices.eagleview.com`. This is the legacy REST API described at https://restdoc.eagleview.com/; credentials for the newer apicenter developer API may require a different implementation. The app deliberately does not accept arbitrary provider URLs.

Token rotation/refresh is managed outside this app. The legacy documentation describes short-lived bearer tokens; replace the environment value before expiry and restart. Keys are never exposed to the frontend.

**Existing reports:** choose New estimate → EagleView report. Supply a completed report ID. Completed status (`StatusId=5`) and parseable imperial area/pitch are required. Totals combine ridge+hip and eave+rake lengths. Multiple structures may be present in total measurements; review the report scope. Unsupported units, absent pitch, or absent area fail explicitly. Missing optional lengths remain zero allowances.

**Automatic quotes:** choose New estimate → Automatic quote. Enter the address/customer, product, delivery, detached-garage inclusion and property-change flag. Request a provider price; nothing is ordered yet. The next panel shows the exact priced property and product. Confirm the paid order to submit. A priced order expires after ten minutes. The quoted range is the provider's estimate, not a contractual cap; adjustments are handled in the EagleView portal.

The app stores an idempotency key before submission. A transport failure or ambiguous order response is **not retried automatically**, because the order may already have been charged. Check the provider portal using the displayed reference ID before placing any replacement order. An interrupted `ordering` state likewise requires portal reconciliation. The app does not automatically accept upgrades, pay adjustments or cancel a report.

The server checks up to ten eligible waiting reports per minute while it runs. Jobs survive restarts. A completed report atomically creates one draft, using pricing captured during price lookup. Unknown site conditions use explicit default scope assumptions and all review checks start unchecked. A report pending user action must be handled in the provider portal. Credentials/coverage failures remain visible in job messages. `POST /api/jobs/check` triggers a check of eligible jobs without bypassing their poll delay.

## RentCast

Set `RENTCAST_API_KEY`. After adding a non-demo measurement, choose **Look up with RentCast**. Results include the matched address, year built, property type and living area where available. Confirm the returned address; these records are optional context, never roofing geometry.

## Normalized report import

Use `examples/measurement.json` or download the template from Integrations. Required: `address`, positive `areaSqFt`, numeric pitch rise over 12, and `areaType` (`surface` or `footprint`, defaults to surface). Optional: `ridgeFt`, `edgeFt`, `valleyFt`, `facets`, `reference`, `notes`. Imperial units only. Limit 250 KB in UI / 256 KB API body. A vendor PDF/XML/JSON must first be converted to this schema. Native PDF extraction and arbitrary report interpretation are not implemented.

## Property Data v2 sandbox (new)

This is separate from legacy WebServices. In EagleView Developer create a **sandbox application** with **Property Data** access and **Client Credentials** authentication. Add its credentials to the local server `.env`:

```dotenv
EAGLEVIEW_CLIENT_ID=
EAGLEVIEW_CLIENT_SECRET=
```

Restart `npm start` after saving, then reload Roofline. **New estimate → EagleView sandbox** offers all 100 published Omaha sample addresses. No Google key or production go-live is needed for this workflow. Request data, wait for processing, confirm the returned address and choose a structure. Roofline applies the existing company pricebook. Add customer information and save a test draft.

The connector is hardcoded to `https://sandbox.apis.eagleview.com`. OAuth uses `https://apicenter.eagleview.com/oauth2/v1/token`, which is the documented token endpoint for sandbox credentials as well. Tokens are cached in memory until shortly before expiry and renewed once on a 401. Secrets remain server-side and are never included in exported source bundles.

Requests and selected measurements persist in SQLite. The screen polls every ten seconds for up to three minutes, then offers Resume checking. Recent requests can be resumed after a reload. Only the published sample addresses are accepted by this initial UI/API. Results outside the documented region are not supported. Each structure must be selected individually; missing area/pitch or unsupported units cannot produce a measurement. Surface area is already 3D and must not be pitch-adjusted again. Linear lengths are unavailable in this integration and explicitly excluded as zero allowances. Sandbox proposals remain drafts and carry test-only labels in the UI and PDF.

These fixtures are provider-response mocks used by automated tests, not a substitute for a live sandbox check. Live verification requires your sandbox credentials and the data pack entitlement that returns roof area/pitch.

Sources: [sandbox and addresses](https://developer.eagleview.com/docs/property-data/sandbox.md), [authentication](https://developer.eagleview.com/docs/authentication/client-credentials.md), [response schema](https://developer.eagleview.com/docs/property-data/openapi/property-data-v2-openapi.json), [data dictionary](https://developer.eagleview.com/docs/property-data/data-dictionary.md).
