import { z } from 'zod';
import { measurementSchema, type Connector } from '../shared/types.ts';
import { AppError } from './errors.ts';

type Env = Record<string, string | undefined>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
function evNumber(value: unknown, unit: 'area' | 'length' | 'pitch' | 'count', optional = false): number {
  if ((value === undefined || value === null || value === '') && optional) return 0;
  const clean = String(value ?? '').trim().replace(/,/g, '');
  const patterns = { area: /^(\d+(?:\.\d+)?)\s*(?:sq\.?\s*ft\.?|sqft|ft²)?$/i, length: /^(\d+(?:\.\d+)?)\s*(?:ft\.?|feet|')?$/i, pitch: /^(\d+(?:\.\d+)?)\s*(?:\/\s*12|:\s*12)?$/, count: /^(\d+)$/ };
  const match = clean.match(patterns[unit]);
  if (!match) throw new AppError(422, `Report has missing or unsupported ${unit} measurements. Use a completed US/imperial report or normalized JSON import.`);
  return Number(match[1]);
}
export function normalizeEagleView(raw: unknown) {
  const r = z.record(z.string(), z.unknown()).parse(raw);
  const total = r.TotalMeasurements && typeof r.TotalMeasurements === 'object' ? r.TotalMeasurements as Record<string, unknown> : r;
  const value = (name: string) => total[name] ?? r[name];
  return measurementSchema.parse({
    address: [r.Street, r.City, r.State, r.Zip].filter(Boolean).join(', '),
    areaSqFt: evNumber(value('Area'), 'area'), areaType: 'surface',
    pitch: evNumber(value('PrimaryPitch') ?? r.Pitch, 'pitch'),
    ridgeFt: evNumber(value('LengthRidge'), 'length', true) + evNumber(value('LengthHip'), 'length', true),
    edgeFt: evNumber(value('LengthEave'), 'length', true) + evNumber(value('LengthRake'), 'length', true),
    valleyFt: evNumber(value('LengthValley'), 'length', true),
    facets: value('TotalRoofFacets') ? evNumber(value('TotalRoofFacets'), 'count') : undefined,
    reference: `EagleView #${r.ReportId}`,
    notes: 'US/imperial report. Totals may include multiple structures. Check report scope and all roof pitches before finalizing. Missing linear measurements are zero allowances, not measured zero lengths.',
  });
}
export class ProviderClient {
  constructor(private env: Env = process.env, private fetcher: Fetcher = fetch) {}
  private key(name: string) { const key = this.env[name]; if (!key) throw new AppError(503, `Set ${name} on the server to enable this connector.`); return key; }
  async request(url: URL, init: RequestInit = {}) {
    try {
      const response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok || response.status === 204) throw new AppError(response.status === 429 ? 429 : 502, response.status === 429 ? 'Provider quota reached. Check your account limits and try again later.' : response.status === 401 || response.status === 403 ? 'Provider rejected credentials or account permissions. Check connector access.' : response.status === 204 || response.status === 404 ? 'Provider returned no report or property. Check the address/report ID and completion status.' : `Provider request failed (${response.status}). Try again later.`);
      return response;
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError(502, 'Provider connection failed or timed out. Check service availability and try again.'); }
  }
  async geocode(address: string) {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.search = new URLSearchParams({address,components:'country:US',key:this.key('GOOGLE_MAPS_API_KEY')}).toString();
    const data = await (await this.request(url)).json() as any;
    if (data.status === 'ZERO_RESULTS') throw new AppError(404, 'No matching US property found. Include street, city, state and ZIP.');
    if (data.status !== 'OK') throw new AppError(502, data.status === 'OVER_QUERY_LIMIT' ? 'Google Maps quota reached. Check your billing and quota.' : 'Google Maps lookup failed. Check API enablement and key restrictions.');
    return (data.results as any[]).slice(0,5).map(r => ({ address: r.formatted_address as string, placeId:r.place_id as string, lat:r.geometry.location.lat as number, lng:r.geometry.location.lng as number, needsConfirmation:!!r.partial_match || r.geometry.location_type !== 'ROOFTOP' }));
  }
  async satellite(lat: number, lng: number) {
    const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
    url.search = new URLSearchParams({center:`${lat},${lng}`,zoom:'20',size:'640x480',scale:'2',maptype:'satellite',key:this.key('GOOGLE_MAPS_API_KEY')}).toString();
    return this.request(url);
  }
  async property(address: string) {
    const url = new URL('https://api.rentcast.io/v1/properties'); url.searchParams.set('address',address);
    const data = await (await this.request(url,{headers:{'X-Api-Key':this.key('RENTCAST_API_KEY'),Accept:'application/json'}})).json() as any[];
    if (!Array.isArray(data) || !data.length) throw new AppError(404,'No property record found.');
    const r = data[0];
    return {address:r.formattedAddress,yearBuilt:r.yearBuilt,propertyType:r.propertyType,livingAreaSqFt:r.squareFootage,bedrooms:r.bedrooms,bathrooms:r.bathrooms,note:'Property context only. Living area is not roof area. Confirm the returned address.'};
  }
  async eagleview(reportId: string) {
    if (!/^\d{1,15}$/.test(reportId)) throw new AppError(400,'Report ID must be numeric.');
    const token = this.key('EAGLEVIEW_ACCESS_TOKEN');
    const host = this.env.EAGLEVIEW_ENV === 'production' ? 'https://webservices.eagleview.com' : 'https://webservices-integrations.eagleview.com';
    const url = new URL('/v3/Report/GetReport',host); url.searchParams.set('reportId',reportId);
    const raw = await (await this.request(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}})).json() as any;
    if(raw.StatusId !== 5 && !/^completed$/i.test(raw.Status??''))throw new AppError(409,'EagleView report is not completed. Check the provider portal for progress or required action.');
    return normalizeEagleView(raw);
  }
  async eagleviewOrder(payload:unknown, priceOnly:boolean) {
    const token=this.key('EAGLEVIEW_ACCESS_TOKEN');
    const host=this.env.EAGLEVIEW_ENV==='production'?'https://webservices.eagleview.com':'https://webservices-integrations.eagleview.com';
    return (await this.request(new URL(priceOnly?'/v2/Order/PriceOrder':'/v2/Order/PlaceOrder',host),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)})).json();
  }
  connectors(): Connector[] {
    return [
      {id:'google',name:'Google Maps',description:'Find a US address and view current available satellite imagery.',configured:!!this.env.GOOGLE_MAPS_API_KEY,setup:'Set GOOGLE_MAPS_API_KEY. Enable Geocoding API and Maps Static API with billing and server IP restrictions.',docs:'https://developers.google.com/maps/documentation/geocoding/overview'},
      {id:'eagleview',name:'EagleView',description:'Retrieve completed roof reports, including area, pitch and edge measurements.',configured:!!this.env.EAGLEVIEW_ACCESS_TOKEN,setup:'Legacy WebServices connector. Set EAGLEVIEW_ACCESS_TOKEN and EAGLEVIEW_ENV=sandbox or production. Obtain the matching account entitlement. Token renewal is managed by your account integration.',docs:'https://restdoc.eagleview.com/'},
      {id:'rentcast',name:'RentCast',description:'Enrich a property with building type, year built and living area.',configured:!!this.env.RENTCAST_API_KEY,setup:'Set RENTCAST_API_KEY. Property records are optional and never substitute for roof measurements.',docs:'https://developers.rentcast.io/reference/property-records'},
      {id:'import',name:'Measurement import',description:'Use a normalized JSON report from your measurement service or field team.',configured:true,setup:'Import a Roofline JSON report using the example in examples/measurement.json. This is not a native EagleView/Roofr PDF parser.',docs:'/api/example-report'},
    ];
  }
}
