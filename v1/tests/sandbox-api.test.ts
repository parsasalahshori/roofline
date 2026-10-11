import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.ts';
import {EagleViewSandbox} from '../server/eagleview-sandbox.ts';
import {defaultScope,defaultPricebook} from '../shared/pricing.ts';
const id='5decd115-771d-4fcc-9d13-0e357a1cacb3';
test('sandbox request → chosen structure → draft persists; arbitrary addresses and customer-ready transitions are blocked',async()=>{
 let requests=0;
 const sandbox=new EagleViewSandbox({EAGLEVIEW_CLIENT_ID:'test',EAGLEVIEW_CLIENT_SECRET:'hidden'},async(url,init)=>{
 if(url.includes('oauth2'))return Response.json({access_token:'test',expires_in:3600});
 if(init?.method==='POST'){requests++;return Response.json({request:{id,status:'In Progress'}},{status:202});}
 return Response.json({request:{id,status:'Complete'},response_address:{full_address:'4220 Barker Ave, Omaha, NE 68105'},structures:[{roof:{structure_roof_area:{value:2100,unit:'square feet'},structure_roof_predominant_pitch:{value:5,unit:'over 12'}}}]});
 });
 const {app,store}=createApp({databasePath:':memory:',demo:true,adminEmail:'owner@example.com',apiToken:'a'.repeat(40),sandbox});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base=`http://127.0.0.1:${(server.address() as any).port}/api`;
 const req=(path:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers:{Authorization:'Bearer '+'a'.repeat(40),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 try{
 assert.equal((await fetch(base+'/sandbox/properties')).status,401);
 const properties=await(await req('/sandbox/properties')).json();assert.equal(properties.length,100);
 assert.equal((await req('/sandbox/requests','POST',{address:'123 not in sandbox'})).status,400);assert.equal(requests,0);
 const job=await(await req('/sandbox/requests','POST',{address:properties[0].address})).json();assert.equal(job.status,'pending');
 assert.equal((await req(`/sandbox/requests/${id}/select`,'POST',{index:0})).status,409);
 const done=await(await req(`/sandbox/requests/${id}`)).json();assert.equal(done.status,'complete');
 assert.equal((await req(`/sandbox/requests/${id}/select`,'POST',{index:99})).status,409);
 const m=await(await req(`/sandbox/requests/${id}/select`,'POST',{index:0})).json();assert.equal(m.source,'eagleview-sandbox');assert.equal(m.areaSqFt,2100);
 const repeat=await(await req(`/sandbox/requests/${id}/select`,'POST',{index:0})).json();assert.equal(m.id,repeat.id);
 const q=await(await req('/quotes','POST',{measurementId:m.id,previewPricebook:defaultPricebook,scope:{...defaultScope,areaSqFt:m.areaSqFt,pitch:m.pitch},customer:{name:'Sandbox test'},review:{property:true,measurements:true,scope:true}})).json();
 assert.equal(q.status,'draft');assert.ok(q.calculation.totalCents>0);assert.equal((await req(`/quotes/${q.id}/status`,'PATCH',{status:'ready'})).status,409);
 const saved=await(await req('/sandbox/requests')).json();assert.equal(saved[0].roofs[0].measurementId,m.id);
 assert.ok(!JSON.stringify(saved).includes('hidden'));
 }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();}
});
