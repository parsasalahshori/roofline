/** Response shapes of the storm API (plan Task 11: GET /api/storms, GET /api/storms/:id). Types only. */

export type StormStatus = 'provisional' | 'final';
export type CompanyStormStatus = 'new' | 'planned' | 'dismissed';

/** One company storm in the list. `day` is YYYY-MM-DD in the company time zone. `maxIn` is radar-estimated inches. */
export type StormSummary = {
  id: string;
  placeName: string | null;
  day: string;
  maxIn: number;
  status: StormStatus;
  customersHit: number;
  homesHit: number;
  planTaskId: string | null;
  planStatus: string | null;
};

export type StormsList = { storms: StormSummary[] };

/** GeoJSON, loosely typed; each swath feature has properties.thresholdIn (the contour level). */
export type SwathFeature = {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: { thresholdIn: number } & Record<string, unknown>;
};
export type SwathCollection = { type: 'FeatureCollection'; features: SwathFeature[] };

/** Live results of a storm plan (spec 5.5). Every field is a count except adSpendCents and adMaxCents (integer cents). */
export type StormResultsView = {
  textsSent: number;
  textsDelivered: number;
  replies: number;
  yesReplies: number;
  emailsSent: number;
  unsubscribes: number;
  doorsKnocked: number;
  wantsCheck: number;
  adSpendCents: number;
  adMaxCents: number;
  adClicks: number;
  landingRequests: number;
  inspectionsBooked: number;
};

export type StormDetailView = {
  storm: StormSummary;
  swath: SwathCollection;
  results: StormResultsView;
  plan: { taskId: string; status: string } | null;
};
