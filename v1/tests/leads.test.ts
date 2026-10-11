import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app.ts';
import {sandboxProperties} from '../shared/sandbox-properties.ts';

test('saved map properties require authentication, are idempotent and survive a server restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'roofline-leads-'));
 const config={databasePath:join(dir,'leads.sqlite'),demo:true,adminEmail:'owner@example.com',apiToken:'a'.repeat(40)};
 const start=async()=>{const instance=createApp(config);const server=instance.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));return {...instance,server,base:`http://127.0.0.1:${(server.address() as {port:number}).port}/api`};};
 let app=await start();
 const req=(path:string,method='GET',body?:unknown)=>fetch(app.base+path,{method,headers:{Authorization:'Bearer '+config.apiToken,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 try{
   assert.equal((await fetch(app.base+'/leads')).status,401);
   assert.equal((await fetch(app.base+'/leads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:sandboxProperties[0].address})})).status,401);
   assert.equal((await req('/leads','POST',{address:'Unknown address',lat:1,lon:1})).status,400);
   const response=await req('/leads','POST',{address:sandboxProperties[0].address,lat:0,lon:0});assert.equal(response.status,201);
   const lead=await response.json();assert.equal(lead.lat,sandboxProperties[0].lat);assert.equal(lead.lon,sandboxProperties[0].lon);assert.equal(lead.source,'eagleview-sandbox');
   const repeat=await(await req('/leads','POST',{address:sandboxProperties[0].address})).json();assert.equal(repeat.id,lead.id);
   assert.equal((await(await req('/leads')).json()).length,1);
   await new Promise<void>(r=>app.server.close(()=>r()));app.store.close();app=await start();
   assert.equal((await(await req('/leads')).json())[0].id,lead.id);
   assert.equal((await req('/storms/hail?date=2026-02-30')).status,400);
 }finally{await new Promise<void>(r=>app.server.close(()=>r()));app.store.close();rmSync(dir,{recursive:true,force:true});}
});
