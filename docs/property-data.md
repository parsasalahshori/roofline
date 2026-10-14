# Property data: who owns the house (Arkansas first)

What it is for: the roofer opens a home (the measure screen, or a home in the customer window), presses
**Owner records**, and sees the county's public record for that house: owner name(s), whether the owner
lives there, their mailing address, year built, living area, last sale, appraised value, parcel number, and
a street-level photo when there is one. Nothing is fetched until the button is pressed, because the paid
provider bills per record.

Researched 2026-10-13. Prices change; check the links before you buy.

## Recommendation

**Regrid Parcel API, Self-Serve plan, Standard schema.** It is the one provider with a self-serve signup
and an API token you can paste in the same day, with every Arkansas county, owner names, owner mailing
address, year built, building area, last sale date and price, and the parcel boundary, in a documented
REST API. Every field the panel uses is in the Standard schema except `homestead_exemption` (Premium
only), which only sharpens "lives here"; without it the app compares the mailing address with the house.
ATTOM, Cotality (CoreLogic) and BatchData have the same or richer data, but go through sales
calls, annual contracts or minimums before you get a production key.

**Free fallback, already built:** the Arkansas GIS Office's statewide parcel layer. It is open (no key), it
covers all 75 counties (2,149,448 parcels when checked on 2026-10-13), and every parcel has the county's
owner name, site address and appraised value. Its county data was taken between 2026-07-06 and 2026-09-17
and published 2026-10-01 (from the layer's own `camadate` and `pubdate` columns). It has **no mailing
address, year built or sale**, so "lives here" shows Unknown. Set `PROPERTY_DATA_PROVIDER=arkansas-gis` to
use it with no account at all.

**"Mapillo" is almost certainly Mapillary** (Meta's free street-level photo service). It has no owner data;
it gives a photo of the house from the street. It is free and worth adding: paste a token and the panel
shows the nearest photo, linked to its Mapillary page (the images are CC BY-SA 4.0, so the link is the
credit). Coverage is crowd-sourced and uneven (not checked street by street): expect more photos on main
roads in towns and few or old ones on rural and new streets, so check a few of your addresses on
mapillary.com first. It is a nice-to-have, not the owner data source.

## Comparison

| Provider | Arkansas owner + parcel | Fields | Freshness | Getting a key | Price as found (2026-10-13) |
| --- | --- | --- | --- | --- | --- |
| **Regrid** (recommended) | All counties | Owner 1-4, mailing address, site address, year built, building sq ft, last sale date/price, value, homestead flag, parcel polygon | Each county refreshed on its own schedule; `ll_last_refresh` per parcel | Self-serve at [app.regrid.com/api/plans](https://app.regrid.com/api/plans); 7-day trial token capped at 2,000 parcels and limited to 7 sample counties | Monthly plan includes 2,000 parcel records and 200,000 tiles; overage $0.10/record (Standard) or $0.15/record (Premium) ([changelog v2025.9.23](https://support.regrid.com/changelog/self-serve-api-plans)). The base monthly fee is shown only on the plans page after sign-in. Enterprise (over 10,000 records a month, matched buildings, enhanced ownership): annual, quoted ([plan options](https://support.regrid.com/reference/plan-options)) |
| Arkansas GIS Office parcels (free fallback, built) | All 75 counties | Owner name, site address, appraised/land/improvement value, parcel polygon | Twice-yearly scheduled loads per county; dates are on every parcel | None: open ArcGIS FeatureServer ([layer 6](https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/6)) | Free |
| ATTOM | Nationwide | Owner, mailing, characteristics, sales, mortgage, AVM | Monthly-ish | Self-serve trial; production through sales and an MSA | Not published; third-party reports say from about $499/yr up to custom contracts ([attomdata.com/api](https://www.attomdata.com/api/)) |
| BatchData | Nationwide | Owner, mailing, characteristics, sales; skip tracing (phones) as add-on | Monthly | Sign-up, then plan | Third-party and own-blog figures: from about $500/month for 20,000 records; billed per returned record ([BatchData plans](https://batchdata.io/plan/growth)) |
| Melissa Property | Nationwide | Owner, mailing, characteristics, last sale, value | Monthly | Self-serve credits | Credit packs; not checked against a current price sheet |
| Cotality (CoreLogic) | Nationwide, deepest | Everything, incl. deed and mortgage history | Daily to monthly | Enterprise sales only | Enterprise contracts |
| Estated | Folded into ATTOM | — | — | New sign-ups go to ATTOM | — |
| Microsoft / Overture building footprints | Buildings only, no owners | Building outline | Yearly | None | Free (ODbL); the app already loads Microsoft footprints for roof outlines |
| Mapillary | No owners | Street-level photo | Crowd-sourced, uneven | Free token at [mapillary.com/dashboard/developers](https://www.mapillary.com/dashboard/developers) | Free |

Licensing: I could not read Regrid's current API terms from here, so whether a SaaS may show the records
to its own customers (roofing companies) on a self-serve plan is not confirmed. Showing one record at a
time inside the app, with no bulk export, is the conservative use the panel makes. Ask parcels@regrid.com
in writing before selling it to customers; an enterprise license covers it explicitly. The Arkansas layer is
public data. Mapillary photos need the link-back credit, which the panel shows.

## Compliance

Owner names and mailing addresses are public county records. Calling or texting the people found this
way is regulated: the TCPA and the National Do Not Call Registry apply to marketing calls and texts, and
Arkansas has its own telemarketing rules. The app shows the record to the roofer only. It never texts,
calls or emails anyone from it, the panel says so, and nothing from it is saved as a customer's phone or
consent. A customer reached this way still has to give consent the normal way before the app texts them.

## Turning it on

Paste the keys where the API reads its environment: the Render web service's Environment tab in
production (and the worker if you want it there later; today only the API uses them), or `.env` for local
runs. Restart (Render redeploys on save).

| Env var | Where to get it | What lights up |
| --- | --- | --- |
| `REGRID_API_TOKEN` | Sign up at [app.regrid.com/api/plans](https://app.regrid.com/api/plans), pick Self-Serve **Standard** (Premium adds the homestead flag and USPS vacancy, $0.15 instead of $0.10 per extra record), copy the token from the API page | Owner records answer from Regrid: owners, lives here, mailing address, year built, living area, last sale, value, parcel, county |
| `PROPERTY_DATA_PROVIDER` | Nothing to get. `arkansas-gis` for the free state layer, `regrid` to be explicit | `arkansas-gis`: owner name, site address, value, parcel, county, with no account. Leave unset to use Regrid when its token is set |
| `MAPILLARY_TOKEN` | Free: sign in at [mapillary.com/dashboard/developers](https://www.mapillary.com/dashboard/developers), register an app, copy its **client token** (starts `MLY|`) | A street photo of the house at the top of Owner records, when one exists within about 55 m |

With none set, the button says "Owner records aren't set up yet." `DEMO_MODE` and `FAKE_PROVIDERS` always
use fictional records (names like "Sample Jordan", parcel numbers `FAKE-...`) and never call a provider.

Cost control: each press of Owner records on a home not yet seen this session is one Regrid record
(the browser keeps a record for 30 minutes). A trial token only answers in Regrid's 7 sample counties, so
test Arkansas with the paid plan or with `PROPERTY_DATA_PROVIDER=arkansas-gis`.

## How it works (for developers)

- Seam: `apps/api/src/providers/property-data.ts` (`PropertyData.lookup({ point, address })` returns
  `PropertyRecordView` from `@roofline/shared`, or null). Clients: `regrid.ts` (token in the
  `x-regrid-token` header; `/parcels/point`, or `/parcels/address` when the home has no point),
  `arkansas-parcels.ts` (ArcGIS point query in WGS84), fake in `fakes/property-data.ts`.
- Street photos: `apps/api/src/providers/street-imagery.ts` (Mapillary Graph API `images?bbox=`, token in
  the `Authorization: OAuth` header; the nearest image wins). Fake in `fakes/street-imagery.ts`. The CSP
  allows Mapillary's image hosts (`*.fbcdn.net`, `*.mapillary.com`).
- Route: `GET /api/properties/:id/record` (routes/properties.ts) reads the home inside `withTenant` with the
  usual visibility rule, then asks the providers outside the transaction. Nothing is stored (no table, no
  migration). Not set up: `{ configured: false }`. Provider outage: 503. A photo outage never fails it.
- Web: `apps/web/src/features/property-data/OwnerRecord.tsx`, shown under the measure screen's address
  strip and on each home in the customer window. Copy in `apps/web/src/copy/propertyData.ts`.
- Tests: `apps/api/test/property-data-providers.test.ts` (clients against hand-written, fictional
  provider-shaped answers in `test/fixtures/{regrid,arkansas-gis,mapillary}`), `property-record.test.ts`
  (the route, database-backed), `apps/web/test/owner-record.test.tsx`.

## Owner to-do

1. Decide: free Arkansas layer now (`PROPERTY_DATA_PROVIDER=arkansas-gis`, no account, no cost) and/or
   Regrid Self-Serve Standard (needs an account and a card; check the monthly fee on the plans page).
2. Optional: a free Mapillary account for `MAPILLARY_TOKEN`.
3. Paste the values in Render's Environment for the API service. Nothing else to deploy.
4. Before selling it to customers: confirm Regrid's display terms in writing, and keep the "do not text or
   call from it" rule in your customer terms.
