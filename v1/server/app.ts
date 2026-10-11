import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { Store } from './store.ts';
import { ProviderClient } from './providers.ts';
import { AppError } from './errors.ts';
import { calculateQuote, pricebookSchema, scopeSchema } from '../shared/pricing.ts';
import { companySchema, measurementSchema, quoteInputSchema, type Measurement, type Quote, type Status, type FollowUp } from '../shared/types.ts';
import { demoMeasurements, seedDemo } from './demo.ts';
import { renderPdf } from './pdf.ts';
import {EagleViewSandbox} from './eagleview-sandbox.ts';
import {sandboxProperties} from '../shared/sandbox-properties.ts';
import { JobService } from './jobs.ts';
import {getHailReports} from './storms.ts';

export type AppConfig = {databasePath:string;demo:boolean;adminEmail:string;adminPassword?:string;apiToken?:string;production?:boolean;providers?:ProviderClient;sandbox?:EagleViewSandbox};
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const safeEqual = (a:string,b:string) => timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
export function createApp(config:AppConfig){
  if(config.production && config.demo)throw Error('DEMO_MODE must be false in production.');
  if(!config.demo && (!config.adminPassword || config.adminPassword.length<12))throw Error('ADMIN_PASSWORD must be at least 12 characters.');
  if(config.apiToken && config.apiToken.length<32)throw Error('API_TOKEN must be at least 32 characters.');
  const store=new Store(config.databasePath), providers=config.providers??new ProviderClient();
  const jobs=new JobService(store,providers);
  const sandbox=config.sandbox??new EagleViewSandbox();
  store.db.exec('CREATE TABLE IF NOT EXISTS sandbox_requests (id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, address TEXT UNIQUE NOT NULL, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS followups (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
  const sandboxRead=(id:string)=>{z.uuid().parse(id);const row=store.db.prepare('SELECT json FROM sandbox_requests WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw new AppError(404,'Sandbox request not found.');return JSON.parse(row.json);};
  const sandboxSave=(job:any)=>{store.db.prepare('INSERT INTO sandbox_requests VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id,JSON.stringify(job));return job;};
  const sandboxInFlight=new Map<string,Promise<any>>();
  // Single-process deployment: restart revokes every browser session, including demo sessions.
  store.db.prepare('DELETE FROM sessions').run();
  const salt=randomBytes(16), passwordHash=scryptSync(config.adminPassword??randomBytes(32).toString('hex'),salt,64);
  if(config.demo)seedDemo(store);
  const app=express();app.disable('x-powered-by');
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'","data:",'https://tile.openstreetmap.org'],connectSrc:["'self'"],upgradeInsecureRequests:config.production?[]:null}},referrerPolicy:{policy:'strict-origin-when-cross-origin'},strictTransportSecurity:config.production?undefined:false}));
  app.use(express.json({limit:'256kb'}));
  app.use('/api',(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    if(config.demo&&!['localhost','127.0.0.1','[::1]','::1'].includes(req.hostname))return res.status(403).json({error:'Demo mode requires a loopback host name.'});
    // Reject browser cross-origin mutations, including logins. CLI has no Origin.
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){
      const origin=req.get('origin');
      if(origin){let host='';try{host=new URL(origin).host;}catch{}if(host!==req.get('host'))return res.status(403).json({error:'Cross-origin request rejected.'});}
      if(req.get('sec-fetch-site')==='cross-site')return res.status(403).json({error:'Cross-site request rejected.'});
    }
    next();
  });
  app.use('/api',rateLimit({windowMs:60000,limit:300,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many requests. Try again in a minute.'}}));
  app.get('/api/health',(_req,res)=>res.json({ok:true,service:'roofline'}));
  app.get('/api/auth/config',(_req,res)=>res.json({demo:config.demo}));
  const cookie=(req:express.Request)=>req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('roofline_session='))?.slice(17);
  const login=(res:express.Response)=>{const token=randomBytes(32).toString('hex');store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(hash(token),Date.now()+8*3600000);res.cookie('roofline_session',token,{httpOnly:true,sameSite:'strict',secure:!!config.production,maxAge:8*3600000,path:'/'});res.json({ok:true});};
  const authLimiter=rateLimit({windowMs:15*60000,limit:20,standardHeaders:true,legacyHeaders:false,message:{error:'Too many login attempts. Try again later.'}});
  app.post('/api/auth/login',authLimiter,(req,res)=>{const v=z.object({email:z.string().max(254),password:z.string().max(1024)}).parse(req.body);if(!safeEqual(v.email.toLowerCase(),config.adminEmail.toLowerCase()) || !timingSafeEqual(scryptSync(v.password,salt,64),passwordHash))throw new AppError(401,'Invalid email or password.');login(res);});
  app.post('/api/auth/demo',authLimiter,(req,res)=>{if(!config.demo || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??''))throw new AppError(403,'Demo access is disabled.');login(res);});
  app.use('/api',(req,res,next)=>{const bearer=req.get('authorization')?.replace(/^Bearer /,'');const token=cookie(req);const validBearer=!!(bearer&&config.apiToken&&safeEqual(bearer,config.apiToken));const validSession=!!(token&&store.db.prepare('SELECT hash FROM sessions WHERE hash=? AND expires>?').get(hash(token),Date.now()));if(!validBearer&&!validSession)return res.status(401).json({error:'Sign in to continue.'});next();});
  app.get('/api/auth/me',(_req,res)=>res.json({email:config.adminEmail,demo:config.demo}));
  app.post('/api/auth/logout',(req,res)=>{const token=cookie(req);if(token)store.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token));res.clearCookie('roofline_session',{path:'/'}).json({ok:true});});
  app.get('/api/settings',(_req,res)=>res.json(store.settings()));
  app.put('/api/settings',(req,res)=>{const data=z.object({company:companySchema,pricebook:pricebookSchema}).parse(req.body);store.saveSettings(data);res.json(data);});
  app.get('/api/connectors',(_req,res)=>res.json([{id:'eagleview-sandbox',name:'EagleView Property Data — sandbox',description:'Free Omaha test properties → roof area and pitch → preliminary estimate.',configured:sandbox.configured(),setup:'Set EAGLEVIEW_CLIENT_ID and EAGLEVIEW_CLIENT_SECRET from a sandbox app with Property Data access. Restart the server. Production is disabled for this connector.',docs:'https://developer.eagleview.com/documentation/property-data/v2/sandbox'},...providers.connectors()]));
  app.get('/api/demo-properties',(_req,res)=>res.json(config.demo?demoMeasurements:[]));
  app.get('/api/example-report',(_req,res)=>{res.setHeader('Content-Disposition','attachment; filename="roofline-measurement.json"');res.json({address:'100 Example Lane, Austin, TX 78704',areaSqFt:2400,areaType:'surface',pitch:6,ridgeFt:70,edgeFt:210,valleyFt:24,facets:6,reference:'Your licensed report ID',notes:'Example only. Replace every measurement with verified values.'});});
  app.post('/api/measurements',(req,res)=>{const source=z.enum(['manual','import']).parse(req.body.source??'manual');const measurement:Measurement={...measurementSchema.parse(req.body),source,id:randomUUID(),createdAt:new Date().toISOString()};res.status(201).json(store.saveMeasurement(measurement));});
  app.post('/api/estimate',(req,res)=>res.json(calculateQuote(scopeSchema.parse(req.body.scope),store.settings().pricebook)));
  const providerLimiter=rateLimit({windowMs:60000,limit:15,message:{error:'Lookup limit reached. Please wait a minute.'}});
  app.use('/api/lookup',providerLimiter);
  app.get('/api/jobs',(_req,res)=>res.json(jobs.list()));
  app.post('/api/jobs/price',providerLimiter,async(req,res)=>res.json(await jobs.price(req.body)));
  app.post('/api/jobs/order',providerLimiter,async(req,res)=>res.status(201).json(await jobs.order(req.body)));
  app.post('/api/jobs/check',providerLimiter,async(_req,res)=>{await jobs.poll();res.json(jobs.list());});
  app.get('/api/storms/hail',providerLimiter,async(req,res)=>res.json(await getHailReports(z.string().parse(req.query.date))));
  app.get('/api/leads',(_req,res)=>res.json((store.db.prepare('SELECT json FROM leads ORDER BY rowid DESC').all() as {json:string}[]).map(r=>JSON.parse(r.json))));
  const readFollowUp=(id:string):FollowUp=>{
    z.uuid().parse(id);
    const row=store.db.prepare('SELECT json FROM followups WHERE id=?').get(id) as {json:string}|undefined;
    if(!row)throw new AppError(404,'Follow-up not found.');
    return JSON.parse(row.json);
  };
  app.get('/api/followups',(_req,res)=>res.json((store.db.prepare('SELECT json FROM followups').all() as {json:string}[]).map(r=>JSON.parse(r.json) as FollowUp).sort((a,b)=>a.dueDate.localeCompare(b.dueDate)||a.createdAt.localeCompare(b.createdAt))));
  app.post('/api/followups',(req,res)=>{
    const input=z.object({quoteId:z.uuid(),dueDate:z.iso.date(),note:z.string().trim().max(500).default('')}).parse(req.body);
    if(!store.quote(input.quoteId))throw new AppError(404,'Choose a saved proposal for this follow-up.');
    const now=new Date().toISOString(),followUp:FollowUp={...input,id:randomUUID(),done:false,createdAt:now,updatedAt:now};
    store.db.prepare('INSERT INTO followups VALUES(?,?)').run(followUp.id,JSON.stringify(followUp));
    res.status(201).json(followUp);
  });
  app.patch('/api/followups/:id',(req,res)=>{
    const previous=readFollowUp(z.string().parse(req.params.id));
    const change=z.object({done:z.boolean().optional(),dueDate:z.iso.date().optional(),note:z.string().trim().max(500).optional()}).refine(v=>Object.keys(v).length>0,{message:'Choose a date, note or completion status to update.'}).parse(req.body);
    const followUp:FollowUp={...previous,...change,updatedAt:new Date().toISOString()};
    store.db.prepare('UPDATE followups SET json=? WHERE id=?').run(JSON.stringify(followUp),followUp.id);
    res.json(followUp);
  });
  app.post('/api/leads',(req,res)=>{
    const {address}=z.object({address:z.string().max(300)}).parse(req.body);
    const p=sandboxProperties.find(p=>p.address===address);if(!p)throw new AppError(400,'Choose a property from the map.');
    const existing=store.db.prepare('SELECT json FROM leads WHERE address=?').get(address) as {json:string}|undefined;
    if(existing)return res.json(JSON.parse(existing.json));
    const lead={...p,id:randomUUID(),createdAt:new Date().toISOString(),source:'eagleview-sandbox'};
    store.db.prepare('INSERT INTO leads VALUES(?,?,?)').run(lead.id,address,JSON.stringify(lead));res.status(201).json(lead);
  });
  app.get('/api/sandbox/properties',(_req,res)=>res.json(sandboxProperties));
  app.get('/api/sandbox/requests',(_req,res)=>res.json((store.db.prepare('SELECT json FROM sandbox_requests ORDER BY rowid DESC LIMIT 10').all() as {json:string}[]).map(r=>JSON.parse(r.json))));
  app.post('/api/sandbox/requests',providerLimiter,async(req,res)=>{
    const {address}=z.object({address:z.string().trim().min(5).max(300)}).parse(req.body);
    if(!sandboxProperties.some(p=>p.address===address))throw new AppError(400,'Choose an address from the EagleView sandbox sample list.');
    const id=await sandbox.start(address);
    res.status(202).json(sandboxSave({id,address,status:'pending',createdAt:new Date().toISOString()}));
  });
  app.get('/api/sandbox/requests/:id',providerLimiter,async(req,res)=>{
    const job=sandboxRead(z.string().parse(req.params.id));
    if(job.status==='complete'||Date.now()<(job.nextCheckAt??0))return res.json(job);
    if(!sandboxInFlight.has(job.id))sandboxInFlight.set(job.id,(async()=>{
      sandboxSave({...job,nextCheckAt:Date.now()+10000});
      const result=await sandbox.result(job.id);
      return sandboxSave({...job,...result,nextCheckAt:Date.now()+10000});
    })());
    try{res.json(await sandboxInFlight.get(job.id));}finally{sandboxInFlight.delete(job.id);}
  });
  app.post('/api/sandbox/requests/:id/select',(req,res)=>{
    const job=sandboxRead(z.string().parse(req.params.id)),{index}=z.object({index:z.number().int().min(0).max(999)}).parse(req.body);
    const roof=job.roofs?.find((r:any)=>r.index===index);
    if(job.status!=='complete'||!roof?.measurement)throw new AppError(409,'Select a completed structure with valid area and pitch.');
    if(roof.measurementId)return res.json(store.measurement(roof.measurementId));
    const m:Measurement={...measurementSchema.parse(roof.measurement),id:randomUUID(),source:'eagleview-sandbox',createdAt:new Date().toISOString()};
    store.db.exec('BEGIN IMMEDIATE');
    try{store.saveMeasurement(m);roof.measurementId=m.id;sandboxSave(job);store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}
    res.status(201).json(m);
  });
  app.post('/api/lookup/geocode',async(req,res)=>{const {address}=z.object({address:z.string().trim().min(5).max(300)}).parse(req.body);res.json(await providers.geocode(address));});
  app.post('/api/lookup/property',async(req,res)=>{const {address}=z.object({address:z.string().trim().min(5).max(300)}).parse(req.body);res.json(await providers.property(address));});
  app.post('/api/lookup/eagleview',async(req,res)=>{const {reportId}=z.object({reportId:z.string().regex(/^\d{1,15}$/)}).parse(req.body);const m:Measurement={...await providers.eagleview(reportId),source:'eagleview',id:randomUUID(),createdAt:new Date().toISOString()};res.status(201).json(store.saveMeasurement(m));});
  app.get('/api/lookup/satellite',async(req,res)=>{const {lat,lng}=z.object({lat:z.coerce.number().min(-90).max(90),lng:z.coerce.number().min(-180).max(180)}).parse(req.query);const upstream=await providers.satellite(lat,lng);const type=upstream.headers.get('content-type')??'';if(!type.startsWith('image/'))throw new AppError(502,'Satellite imagery unavailable. Check Maps Static API configuration.');res.type(type).send(Buffer.from(await upstream.arrayBuffer()));});
  const getQuote=(id:string)=>{const q=store.quote(id);if(!q)throw new AppError(404,'Proposal not found.');return q;};
  app.get('/api/quotes',(_req,res)=>res.json(store.quotes()));
  app.get('/api/quotes/:id',(req,res)=>res.json(getQuote(req.params.id)));
  app.post('/api/quotes',(req,res)=>{
    const input=quoteInputSchema.parse(req.body),m=store.measurement(input.measurementId);if(!m)throw new AppError(404,'Measurement not found. Look up or import a property first.');
    const settings=store.settings(),now=new Date().toISOString();
    if(input.previewPricebook&&JSON.stringify(pricebookSchema.parse(input.previewPricebook))!==JSON.stringify(pricebookSchema.parse(settings.pricebook)))throw new AppError(409,'Company pricing changed since this preview. Reload the workspace, recalculate and review the quote before saving.');
    if(!input.previewPricebook)input.review.scope=false;
    res.status(201).json(store.createQuote({...input,id:randomUUID(),createdAt:now,updatedAt:now,status:'draft',measurement:m,calculation:calculateQuote(input.scope,settings.pricebook),pricebook:settings.pricebook,company:settings.company,validUntil:new Date(Date.now()+settings.company.proposalDays*86400000).toISOString()}));
  });
  app.put('/api/quotes/:id',(req,res)=>{
    const old=getQuote(req.params.id);if(old.status!=='draft')throw new AppError(409,'Only drafts can be edited. Duplicate this proposal to create a revision.');
    const input=quoteInputSchema.parse(req.body),m=store.measurement(input.measurementId);if(!m)throw new AppError(404,'Measurement not found.');
    res.json(store.updateQuote({...old,...input,measurement:m,calculation:calculateQuote(input.scope,old.pricebook),updatedAt:new Date().toISOString()},'Draft updated'));
  });
  app.post('/api/quotes/:id/duplicate',(req,res)=>{const q=getQuote(req.params.id),settings=store.settings(),now=new Date().toISOString();res.status(201).json(store.createQuote({...q,id:randomUUID(),status:'draft',createdAt:now,updatedAt:now,review:{property:false,measurements:false,scope:false},pricebook:settings.pricebook,company:settings.company,calculation:calculateQuote(q.scope,settings.pricebook),validUntil:new Date(Date.now()+settings.company.proposalDays*86400000).toISOString()}));});
  const transitions:Record<Status,Status[]>={draft:['ready'],ready:['sent'],sent:['accepted','declined'],accepted:[],declined:[]};
  app.patch('/api/quotes/:id/status',(req,res)=>{const q=getQuote(req.params.id);const {status}=z.object({status:z.enum(['ready','sent','accepted','declined'])}).parse(req.body);if(q.measurement.source==='eagleview-sandbox')throw new AppError(409,'Sandbox estimates are test-only and must remain drafts.');if(!transitions[q.status].includes(status))throw new AppError(409,`Cannot move ${q.status} to ${status}.`);if(status==='ready'&&!Object.values(q.review).every(Boolean))throw new AppError(409,'Confirm property, measurements and scope before marking ready.');res.json(store.updateQuote({...q,status,updatedAt:new Date().toISOString()},status==='sent'?'Marked sent externally':status==='accepted'?'Acceptance recorded by operator':`Status changed to ${status}`));});
  app.get('/api/quotes/:id/events',(req,res)=>{getQuote(req.params.id);res.json(store.events(req.params.id));});
  app.get('/api/quotes/:id/pdf',(req,res)=>renderPdf(getQuote(req.params.id),res));
  app.get('/api/quotes/:id/json',(req,res)=>{const q=getQuote(req.params.id);res.setHeader('Content-Disposition',`attachment; filename="${q.number}.json"`);res.json(q);});
  app.get('/api/customers',(_req,res)=>{const groups=new Map<string,{name:string;email:string;phone:string;quoteCount:number;totalCents:number;address:string}>();for(const q of store.quotes()){const key=q.customer.email.toLowerCase()||`${q.customer.name.toLowerCase()}|${q.customer.phone}`;const c=groups.get(key)??{...q.customer,quoteCount:0,totalCents:0,address:q.measurement.address};c.quoteCount++;c.totalCents+=q.calculation.totalCents;groups.set(key,c);}res.json([...groups.values()]);});
  app.use('/api',(_req,res)=>res.status(404).json({error:'API endpoint not found.'}));
  if(existsSync(resolve('dist/index.html'))){app.use(express.static(resolve('dist')));app.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/index.html')));}
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(res.headersSent)return;
    if(error instanceof z.ZodError)return res.status(400).json({error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')});
    if(error instanceof AppError)return res.status(error.status).json({error:error.message});
    if(error instanceof SyntaxError)return res.status(400).json({error:'Invalid JSON request.'});
    console.error('Request failed:',error instanceof Error?error.name:'unknown');res.status(500).json({error:'The request could not be completed. Please try again.'});
  });
  return {app,store,jobs};
}
