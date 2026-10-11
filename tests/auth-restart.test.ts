import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.ts';
test('switching demo to live invalidates old sessions and preserves saved quotes',async(t)=>{
 const dir=await mkdtemp(join(tmpdir(),'roofline-auth-'));
 const start=async(demo:boolean)=>{const instance=createApp({databasePath:join(dir,'db.sqlite'),demo,adminEmail:'owner@example.com',adminPassword:'new-secure-password-123'});const server=instance.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));return {...instance,server,url:`http://127.0.0.1:${(server.address() as any).port}`};};
 let first=await start(true);
 t.after(()=>{try{first.server.close();first.store.close();}catch{}});
 const rebound=await fetch(first.url+'/api/auth/demo',{method:'POST',headers:{Host:'attacker.example',Origin:'http://attacker.example'}});
 assert.equal(rebound.status,403,'Demo authentication must reject non-loopback Host names');
 const login=await fetch(first.url+'/api/auth/demo',{method:'POST'});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie')!.split(';')[0];
 const quoteCount=first.store.quotes().length;
 await new Promise<void>(r=>first.server.close(()=>r()));first.store.close();
 const second=await start(false);
 try{const response=await fetch(second.url+'/api/quotes',{headers:{Cookie:cookie}});assert.equal(response.status,401);assert.equal(second.store.quotes().length,quoteCount);}
 finally{await new Promise<void>(r=>second.server.close(()=>r()));second.store.close();await rm(dir,{recursive:true,force:true});}
});
