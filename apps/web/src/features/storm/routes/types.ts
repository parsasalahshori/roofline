/** Response shapes of the door-routes API (plan Task 15). Types only. Stops carry an address and nothing about an owner. */

import type { DoorOutcome, DoorRouteStatus } from '@roofline/shared';

export type { DoorRouteStatus };
/** Kept as an alias so existing imports still work; the union lives in @roofline/shared. */
export type DoorOutcomeKey = DoorOutcome;

/** One route in the rep's list. */
export type RouteSummary = {
  id: string;
  companyStormId: string;
  stormId: string;
  userId: string;
  name: string;
  status: DoorRouteStatus;
  /** Number of stops on the route. */
  stops: number;
  /** Stops that already have an outcome. */
  doneStops: number;
};

/** GET /api/routes/mine */
export type MyRoutesList = { routes: RouteSummary[] };

/** One door. `outcome` is null until the rep records one. `hailIn` is radar-estimated inches. */
export type DoorStop = {
  id: string;
  routeId: string;
  position: number;
  footprintId: number | null;
  propertyId: string | null;
  /** Null for a footprint-only home with no saved address. */
  address: string | null;
  lat: number;
  lng: number;
  /** Null when no hail size is known. */
  hailIn: number | null;
  outcome: DoorOutcomeKey | null;
  /** ISO string or null. */
  outcomeAt: string | null;
  outcomeBy: string | null;
  createdCustomerId: string | null;
  createdJobId: string | null;
};

/** GET /api/routes/:id */
export type RouteDetailView = { route: RouteSummary; stops: DoorStop[] };

/** The lead typed into the "Wants a check" sheet. phoneE164 and email are left out when empty. */
export type DoorLead = { name: string; phoneE164?: string; email?: string; okToText: boolean; note?: string };

/** POST /api/routes/:id/stops/:stopId/outcome body. `lead` is required for wants_check. */
export type OutcomeBody = { outcome: DoorOutcomeKey; lead?: DoorLead };

/** The POST answer. */
export type OutcomeResult = { stop: DoorStop; createdJobId?: string };

/** What useRecordOutcome takes. */
export type RecordOutcomeVars = { routeId: string; stopId: string } & OutcomeBody;
