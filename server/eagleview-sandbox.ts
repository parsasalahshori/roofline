import {z} from 'zod';
import {measurementSchema} from '../shared/types.ts';
import {AppError} from './errors.ts';

type Fetcher=(url:string,init?:RequestInit)=>Promise<Response>;
const requestId=z.uuid();
export type SandboxRoof={index:number;measurement?:z.infer<typeof measurementSchema>;error?:string};
export function normalizePropertyData(raw:unknown):SandboxRoof[]{
 const data=z.object({request:z.object({id:requestId,status:z.literal('Complete')}),response_address:z.object({full_address:z.string().min(5).max(300)}),structures:z.array(z.unknown()).max(1000)}).parse(raw);
 if(!data.structures.length)throw new AppError(422,'No roof structures returned. Choose another sandbox address.');
 return data.structures.map((structure,index)=>{
  const parsed=z.object({roof:z.object({structure_roof_area:z.object({value:z.number().positive().max(100000),unit:z.literal('square feet')}),structure_roof_predominant_pitch:z.object({value:z.number().min(0).max(24),unit:z.literal('over 12')})})}).safeParse(structure);
  if(!parsed.success)return {index,error:'Roof area or pitch is missing or uses unsupported units. Check the app’s Property Data pack entitlement.'};
  return {index,measurement:measurementSchema.parse({address:data.response_address.full_address,areaSqFt:parsed.data.roof.structure_roof_area.value,areaType:'surface',pitch:parsed.data.roof.structure_roof_predominant_pitch.value,reference:`EagleView sandbox ${data.request.id} · structure ${index+1}`,notes:'SANDBOX TEST ONLY — not a customer quote. EagleView Property Data estimated 3D surface area and predominant pitch for the selected structure only. Other structures excluded. Ridge, hip, eave, rake and valley lengths are unavailable and set to zero allowances; enter verified lengths before real estimating. Confirm building, mixed pitches and site conditions.'})};
 });
}
export class EagleViewSandbox{
 private token?:{value:string;expires:number};
 private tokenPending?:Promise<string>;
 constructor(private env:Record<string,string|undefined>=process.env,private fetcher:Fetcher=fetch,private now=Date.now){}
 configured(){return !!(this.env.EAGLEVIEW_CLIENT_ID&&this.env.EAGLEVIEW_CLIENT_SECRET);}
 private async send(url:string,init:RequestInit){
  try{return await this.fetcher(url,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});}
  catch{throw new AppError(502,'EagleView sandbox connection failed or timed out. Try checking the saved request again.');}
 }
 private check(r:Response){
  if(r.ok&&r.status!==204)return;
  throw new AppError(r.status===429?429:502,r.status===401||r.status===403?'EagleView rejected sandbox credentials or Property Data access. Check your sandbox app configuration.':r.status===429?'EagleView sandbox rate limit reached. Wait before checking again.':r.status===404||r.status===422||r.status===204?'No sandbox data available. Choose a documented Omaha test address and check data pack access.':`EagleView sandbox request failed (${r.status}).`);
 }
 private async accessToken():Promise<string>{
  if(!this.configured())throw new AppError(503,'Set EAGLEVIEW_CLIENT_ID and EAGLEVIEW_CLIENT_SECRET in the server .env using your Property Data sandbox app credentials, then restart.');
  if(this.token&&this.token.expires>this.now())return this.token.value;
  if(this.tokenPending)return this.tokenPending;
  this.tokenPending=(async()=>{const r=await this.send('https://apicenter.eagleview.com/oauth2/v1/token',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${this.env.EAGLEVIEW_CLIENT_ID}:${this.env.EAGLEVIEW_CLIENT_SECRET}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:'grant_type=client_credentials'});this.check(r);const t=z.object({access_token:z.string().min(1),expires_in:z.number().positive()}).parse(await r.json());this.token={value:t.access_token,expires:this.now()+Math.max(0,t.expires_in-60)*1000};return t.access_token;})();
  try{return await this.tokenPending;}finally{this.tokenPending=undefined;}
 }
 private async request(path:string,body?:unknown){
  const send=async()=>this.send('https://sandbox.apis.eagleview.com'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${await this.accessToken()}`,'Content-Type':'application/json',Accept:'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  let r=await send();
  if(r.status===401){this.token=undefined;r=await send();}
  this.check(r);return r;
 }
 async start(address:string){
  const r=await this.request('/property/v2/request',{address:{completeAddress:address}});
  const data=z.object({request:z.object({id:requestId,status:z.string()})}).parse(await r.json());
  if(data.request.status==='Failure')throw new AppError(422,'EagleView could not process this sandbox property.');
  return data.request.id;
 }
 async result(id:string):Promise<{status:'pending'}|{status:'complete';roofs:SandboxRoof[]}>{
  requestId.parse(id);const r=await this.request(`/property/v2/result/${id}`);const data=await r.json();
  if((data?.request?.status??data?.status)==='Failure')throw new AppError(422,'EagleView could not process this sandbox property. Choose another test address.');
  if(r.status===202)return {status:'pending'};
  if(data?.request?.id!==id)throw new AppError(502,'EagleView returned a different request ID. No measurements were imported.');
  return {status:'complete',roofs:normalizePropertyData(data)};
 }
}
