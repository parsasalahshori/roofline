import type { Store } from './store.ts';
import { calculateQuote, defaultScope } from '../shared/pricing.ts';
import type { Measurement, Status } from '../shared/types.ts';

export const demoMeasurements: Measurement[] = [
  {id:'demo-oak',address:'1248 Oakridge Drive, Austin, TX 78704',areaSqFt:2480,areaType:'surface',pitch:6,ridgeFt:74,edgeFt:216,valleyFt:32,facets:6,reference:'Sample home A',notes:'Fictional demonstration property. All measurements and rates are sample values.',source:'demo',createdAt:'2026-10-06T16:00:00Z'},
  {id:'demo-cedar',address:'860 Cedar Hollow, Austin, TX 78745',areaSqFt:1960,areaType:'surface',pitch:5,ridgeFt:58,edgeFt:184,valleyFt:18,facets:4,reference:'Sample home B',notes:'Fictional demonstration property. All measurements and rates are sample values.',source:'demo',createdAt:'2026-10-06T16:00:00Z'},
  {id:'demo-willow',address:'312 Willow Creek Lane, Round Rock, TX 78664',areaSqFt:3240,areaType:'surface',pitch:8,ridgeFt:102,edgeFt:272,valleyFt:48,facets:8,reference:'Sample home C',notes:'Fictional demonstration property. All measurements and rates are sample values.',source:'demo',createdAt:'2026-10-06T16:00:00Z'},
];
export function seedDemo(store: Store) {
  if(store.db.prepare("SELECT value FROM metadata WHERE key='demo-seeded'").get())return;
  for(const m of demoMeasurements) if(!store.measurement(m.id))store.saveMeasurement(m);
  const names=['Jordan Miller','Taylor Brooks','Morgan Chen'];
  const statuses:Status[]=['draft','sent','accepted'];
  for(let i=0;i<3;i++){
    const m=demoMeasurements[i], settings=store.settings();
    const scope={...defaultScope,...{areaSqFt:m.areaSqFt,pitch:m.pitch,ridgeFt:m.ridgeFt,edgeFt:m.edgeFt,valleyFt:m.valleyFt},stories:i===2?2:1};
    const date=new Date(Date.now()-(i+1)*86400000).toISOString();
    const quote=store.createQuote({id:crypto.randomUUID(),createdAt:date,updatedAt:date,status:statuses[i],measurement:m,measurementId:m.id,scope,customer:{name:names[i],email:'',phone:''},notes:'Sample proposal for exploring the workspace.',review:{property:i>0,measurements:i>0,scope:i>0},calculation:calculateQuote(scope,settings.pricebook),pricebook:settings.pricebook,company:settings.company,validUntil:new Date(Date.now()+30*86400000).toISOString()});
    if(i>0)store.event(quote.id,`Demo status: ${statuses[i]}`);
  }
  store.db.prepare("INSERT INTO metadata VALUES('demo-seeded','1')").run();
}
