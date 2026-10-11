import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {Store} from './store.ts';
import {ProviderClient} from './providers.ts';
import {AppError} from './errors.ts';
import {customerSchema, type Measurement} from '../shared/types.ts';
import {defaultScope,calculateQuote} from '../shared/pricing.ts';
const orderInput=z.object({street:z.string().trim().min(3).max(50),city:z.string().trim().min(2).max(50),state:z.string().regex(/^[A-Z]{2}$/),zip:z.string().regex(/^\d{5}(-\d{4})?$/),productId:z.number().int().positive(),deliveryId:z.number().int().positive(),includeGarage:z.boolean(),changesInLast4Years:z.boolean(),customer:customerSchema,material:z.enum(['architectural','premium','metal'])});
type Input=z.infer<typeof orderInput>;
type Job={id:string;status:'priced'|'ordering'|'waiting'|'complete'|'attention';input:Input;payload:unknown;minPriceCents:number;maxPriceCents:number;expiresAt:number;createdAt:string;reportId?:string;quoteId?:string;message:string;nextPollAt?:number;settings:ReturnType<Store['settings']>};
export class JobService {
  private polling=false;
  constructor(private store:Store,private providers:ProviderClient){store.db.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, json TEXT NOT NULL)');}
  private save(j:Job){this.store.db.prepare('UPDATE jobs SET json=? WHERE id=?').run(JSON.stringify(j),j.id);return j;}
  list():Job[]{return (this.store.db.prepare('SELECT json FROM jobs ORDER BY rowid DESC').all() as any[]).map(r=>JSON.parse(r.json));}
  async price(raw:unknown){
    const input=orderInput.parse(raw);
    const id=randomUUID();
    const payload={OrderReports:[{ReportAddresses:[{Address:input.street,City:input.city,State:input.state,Zip:input.zip,Country:'US',AddressType:1}],PrimaryProductId:input.productId,DeliveryProductId:input.deliveryId,MeasurementInstructionType:input.includeGarage?1:2,ChangesInLast4Years:input.changesInLast4Years,ReferenceId:id,Comments:'Roofline: US imperial roof measurements requested.'}]};
    const response=await this.providers.eagleviewOrder(payload,true);
    const price=z.object({MinPrice:z.number().nonnegative(),MaxPrice:z.number().nonnegative().max(10000)}).parse(response);
    if(price.MinPrice>price.MaxPrice)throw new AppError(502,'Provider returned an invalid order price.');
    const job:Job={id,status:'priced',input,payload,minPriceCents:Math.round(price.MinPrice*100),maxPriceCents:Math.round(price.MaxPrice*100),expiresAt:Date.now()+10*60000,createdAt:new Date().toISOString(),message:'Review the provider price and authorize this order.',settings:this.store.settings()};
    this.store.db.prepare('INSERT INTO jobs(id,json) VALUES(?,?)').run(id,JSON.stringify(job));return job;
  }
  async order(raw:unknown){
    const input=z.object({priceId:z.string().uuid(),acceptMaxPriceCents:z.number().int().nonnegative(),idempotencyKey:z.string().min(16).max(100)}).parse(raw);
    const existing=this.store.db.prepare('SELECT json FROM jobs WHERE request_key=?').get(input.idempotencyKey) as any;
    if(existing){const job=JSON.parse(existing.json);if(job.id!==input.priceId)throw new AppError(409,'Request key already used for a different order.');return job as Job;}
    const row=this.store.db.prepare('SELECT json FROM jobs WHERE id=?').get(input.priceId) as any;
    if(!row)throw new AppError(404,'Priced order not found.');const job:Job=JSON.parse(row.json);
    if(job.status!=='priced')throw new AppError(409,'This order has already been submitted. Check its status; do not submit it again.');
    if(job.expiresAt<Date.now())throw new AppError(409,'Provider price expired. Request a new price.');
    if(input.acceptMaxPriceCents!==job.maxPriceCents)throw new AppError(409,'Confirm the displayed maximum provider price before ordering.');
    // Claim BEFORE the external side effect. An uncertain result is never auto-retried.
    job.status='ordering';job.message='Order submission in progress. If interrupted, check EagleView using the reference ID before ordering again.';
    this.store.db.prepare('UPDATE jobs SET request_key=?,json=? WHERE id=?').run(input.idempotencyKey,JSON.stringify(job),job.id);
    try{
      const response=z.object({ReportIds:z.array(z.number().int().positive()).length(1)}).parse(await this.providers.eagleviewOrder(job.payload,false));
      job.reportId=String(response.ReportIds[0]);job.status='waiting';job.message='Measurement ordered. The server checks for completion every 60 seconds.';job.nextPollAt=Date.now();return this.save(job);
    }catch(e){job.status='attention';job.message='Order result is uncertain. Check the EagleView portal with reference '+job.id+' before submitting another order. '+(e instanceof AppError?e.message:'Provider response could not be confirmed.');this.save(job);throw new AppError(502,job.message);}
  }
  async poll(){
    if(this.polling)return;this.polling=true;
    try{for(const job of this.list().filter(j=>j.status==='waiting'&&(j.nextPollAt??0)<=Date.now()).slice(0,10)){
      try{
        const report=await this.providers.eagleview(job.reportId!);
        // Commit measurement, draft and completed job atomically to prevent duplicate drafts after a crash.
        const measurement:Measurement={...report,id:randomUUID(),source:'eagleview',createdAt:new Date().toISOString()};
        const scope={...defaultScope,areaSqFt:report.areaSqFt,areaType:report.areaType,pitch:report.pitch,ridgeFt:report.ridgeFt,edgeFt:report.edgeFt,valleyFt:report.valleyFt,material:job.input.material};
        const now=new Date().toISOString(),id=randomUUID();
        this.store.db.exec('BEGIN IMMEDIATE');
        try{
          this.store.saveMeasurement(measurement);
          const seq=this.store.db.prepare('INSERT INTO quotes(id,json) VALUES(?,?)').run(id,'{}').lastInsertRowid;
          const quote={id,number:`RF-${String(seq).padStart(4,'0')}`,measurementId:measurement.id,measurement,scope,customer:job.input.customer,notes:'Automatically generated from EagleView report. Verify all roof pitches, access conditions, scope, pricing and tax. Default story/layer/waste/markup assumptions require review.',review:{property:false,measurements:false,scope:false},status:'draft',createdAt:now,updatedAt:now,company:job.settings.company,pricebook:job.settings.pricebook,calculation:calculateQuote(scope,job.settings.pricebook),validUntil:new Date(Date.now()+job.settings.company.proposalDays*86400000).toISOString()};
          this.store.db.prepare('UPDATE quotes SET json=? WHERE id=?').run(JSON.stringify(quote),id);this.store.event(id,'Draft automatically created from completed EagleView report');
          job.quoteId=id;job.status='complete';job.message='Draft quote generated. Review in Proposals before sending.';this.save(job);this.store.db.exec('COMMIT');
        }catch(e){this.store.db.exec('ROLLBACK');throw e;}
      }catch(e){job.nextPollAt=Date.now()+60000;job.message=e instanceof AppError?e.message:'Report processing failed. Check provider data.';if(e instanceof AppError&&e.status===422)job.status='attention';this.save(job);}
    }}finally{this.polling=false;}
  }
}
