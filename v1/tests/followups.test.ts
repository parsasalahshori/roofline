import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app.ts';

test('follow-ups validate saved proposals and dates, preserve edits and completion across restarts',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'roofline-followups-'));
  const config={databasePath:join(directory,'followups.sqlite'),demo:true,adminEmail:'owner@example.com',apiToken:'a'.repeat(40)};
  const start=async()=>{const instance=createApp(config),server=instance.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));return {...instance,server,base:`http://127.0.0.1:${(server.address() as {port:number}).port}/api`};};
  let instance=await start();
  const request=(path:string,method='GET',body?:unknown)=>fetch(instance.base+path,{method,headers:{Authorization:'Bearer '+config.apiToken,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const close=async()=>{await new Promise<void>(r=>instance.server.close(()=>r()));instance.store.close();};
  try{
    for(const method of ['GET','POST','PATCH'])assert.equal((await fetch(instance.base+'/followups'+(method==='PATCH'?'/'+randomUUID():''),{method,headers:{'Content-Type':'application/json'},body:method==='GET'?undefined:'{}'})).status,401);
    const quote=instance.store.quotes()[0],input={quoteId:quote.id,dueDate:'2026-10-08',note:'  Check on the shingle color  '};
    assert.equal((await request('/followups','POST',{...input,quoteId:randomUUID()})).status,404);
    for(const dueDate of ['October 8','2026-02-30','2026-13-01'])assert.equal((await request('/followups','POST',{...input,dueDate})).status,400);
    assert.equal((await request('/followups','POST',{...input,note:'x'.repeat(501)})).status,400);
    const response=await request('/followups','POST',input);assert.equal(response.status,201);
    const followup=await response.json();assert.equal(followup.note,'Check on the shingle color');assert.equal(followup.done,false);assert.equal(followup.quoteId,quote.id);
    const earlier=await(await request('/followups','POST',{quoteId:quote.id,dueDate:'2026-10-07'})).json();
    assert.equal((await(await request('/followups')).json())[0].id,earlier.id);
    assert.equal((await request('/followups/'+followup.id,'PATCH',{})).status,400);
    assert.equal((await request('/followups/'+followup.id,'PATCH',{dueDate:'2026-02-30'})).status,400);
    assert.equal((await request('/followups/'+randomUUID(),'PATCH',{done:true})).status,404);
    const revised=await(await request('/followups/'+followup.id,'PATCH',{dueDate:'2026-10-10',note:'Call after the site visit'})).json();
    assert.equal(revised.dueDate,'2026-10-10');assert.equal(revised.done,false);assert.equal(revised.createdAt,followup.createdAt);assert.equal(revised.quoteId,quote.id);
    await request('/followups/'+earlier.id,'PATCH',{done:true});
    await close();instance=await start();
    const persisted=await(await request('/followups')).json();
    assert.equal(persisted.find((f:any)=>f.id===followup.id).note,'Call after the site visit');
    assert.equal(persisted.find((f:any)=>f.id===earlier.id).done,true);
    const reopened=await(await request('/followups/'+earlier.id,'PATCH',{done:false})).json();assert.equal(reopened.dueDate,'2026-10-07');assert.equal(reopened.done,false);
  }finally{await close();rmSync(directory,{recursive:true,force:true});}
});
