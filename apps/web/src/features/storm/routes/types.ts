/** Response shapes of the door-routes API (plan Task 15). Types only. Stops carry an address and nothing about an owner. */

export type DoorOutcomeKey = 'not_home' | 'wants_check' | 'not_interested' | 'has_roofer' | 'do_not_knock';
export type DoorRouteStatus = 'ready' | 'in_progress' | 'done';

/** One route in the rep's list. */
export type RouteSummary = {
  id: string;
  name: string;
  status: DoorRouteStatus;
  stopCount: number;
  /** Stops that already have an outcome. */
  doneCount: number;
};

/** GET /api/routes/mine */
export type MyRoutesList = { routes: RouteSummary[] };

/** One door. `outcome` is null until the rep records one. `hailIn` is radar-estimated inches. */
export type DoorStop = {
  id: string;
  position: number;
  address: string;
  lat: number;
  lng: number;
  hailIn: number;
  outcome: DoorOutcomeKey | null;
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
