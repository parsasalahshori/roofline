import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EagleViewSandbox, normalizePropertyData} from '../server/eagleview-sandbox.ts';
const id='5decd115-771d-4fcc-9d13-0e357a1cacb3';
export const result={request:{id,status:'Complete'},response_address:{full_address:'4220 Barker Ave, Omaha, NE 68105'},structures:[{roof:{structure_roof_area:{value:2400,unit:'square feet'},structure_roof_predominant_pitch:{value:6,unit:'over 12'}}}]};
const env={EAGLEVIEW_CLIENT_ID:'test-client',EAGLEVIEW_CLIENT_SECRET:'test-secret'};
test('Property Data uses documented 3D surface area, requires explicit structure selection and does not invent lengths',()=>{
 const roofs=normalizePropertyData({...result,structures:[...result.structures,...result.structures]});
 assert.equal(roofs.length,2);assert.equal(roofs[0].measurement?.areaSqFt,2400);assert.equal(roofs[0].measurement?.areaType,'surface');assert.equal(roofs[0].measurement?.ridgeFt,0);
 assert.match(roofs[0].measurement!.notes,/SANDBOX/);
 assert.equal(normalizePropertyData({...result,structures:[{roof:{structure_roof_area:{value:2400,unit:'square meters'},structure_roof_predominant_pitch:{value:6,unit:'over 12'}}}]} )[0].measurement,undefined);
 assert.equal(normalizePropertyData({...result,structures:[{roof:{structure_roof_area:{value:2400,unit:'square feet'}}}]} )[0].measurement,undefined);
});
test('sandbox authentication is cached, host is fixed, asynchronous requests use known paths',async()=>{
 const calls:{url:string;init?:RequestInit}[]=[];
 const client=new EagleViewSandbox(env,async(url,init)=>{calls.push({url:String(url),init});if(String(url).includes('/oauth2/'))return Response.json({access_token:'token',expires_in:3600});if(init?.method==='POST')return Response.json({request:{id,status:'In Progress',href:'https://untrusted.invalid'}},{status:202});return Response.json(result);});
 assert.equal(await client.start('4220 BARKER AVE, OMAHA, NE 68105'),id);
 const r=await client.result(id);assert.equal(r.status,'complete');
 assert.equal(calls.filter(c=>c.url.includes('/oauth2/')).length,1);
 assert.equal(calls[2].url,'https://sandbox.apis.eagleview.com/property/v2/result/'+id);
 assert.deepEqual(JSON.parse(calls[1].init!.body as string),{address:{completeAddress:'4220 BARKER AVE, OMAHA, NE 68105'}});
 assert.match(String((calls[0].init?.headers as any).Authorization),/^Basic /);
});
test('sandbox fails safely for missing credentials, auth rejection, pending and failure; never falls back to fake data',async()=>{
 await assert.rejects(new EagleViewSandbox({},async()=>{throw Error('must not fetch');}).start('address'),/EAGLEVIEW_CLIENT_ID/);
 const client=new EagleViewSandbox(env,async(url)=>String(url).includes('oauth2')?Response.json({access_token:'token',expires_in:3600}):Response.json({status:'In Progress'},{status:202}));
 assert.equal((await client.result(id)).status,'pending');
 const failure=new EagleViewSandbox(env,async(url)=>String(url).includes('oauth2')?Response.json({access_token:'token',expires_in:3600}):Response.json({request:{id,status:'Failure'}}));
 await assert.rejects(failure.result(id),/could not process/);
 const denied=new EagleViewSandbox(env,async()=>new Response('test-secret',{status:403}));
 await assert.rejects(denied.start('address'),e=>e instanceof Error&&!e.message.includes('test-secret')&&/credentials/.test(e.message));
 await assert.rejects(client.result('../elsewhere'));
});
test('expired or revoked OAuth tokens are replaced without leaking credentials',async()=>{
 let time=0,tokens=0,gets=0;
 const client=new EagleViewSandbox(env,async(url)=>{if(url.includes('oauth2'))return Response.json({access_token:'token'+(++tokens),expires_in:120});if(++gets===1)return new Response('',{status:401});return Response.json(result);},()=>time);
 await client.result(id);assert.equal(tokens,2);time=61000;await client.result(id);assert.equal(tokens,3);
});
