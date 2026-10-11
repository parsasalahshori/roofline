import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import { defaultScope, defaultPricebook } from '../shared/pricing.ts';

test('auth, report import, quote snapshots, reviews, exports and persistence', async () => {
  const { app, store } = createApp({ databasePath: ':memory:', demo: false, adminEmail: 'test@example.com', adminPassword: 'test-password-very-long', apiToken: 'a'.repeat(40) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as {port:number}).port;
  const base = `http://127.0.0.1:${port}`;
  const req = (path:string, method='GET', body?:unknown, token='a'.repeat(40)) => fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:body === undefined ? undefined : JSON.stringify(body)});
  try {
    assert.equal((await req('/quotes','GET',undefined,'wrong')).status,401);
    assert.equal((await req('/auth/demo','POST',{})).status,403);
    const login = await req('/auth/login','POST',{email:'test@example.com',password:'test-password-very-long'});
    assert.equal(login.status,200); assert.match(login.headers.get('set-cookie')!,/HttpOnly/);
    const badOrigin = await fetch(base+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json',Origin:'https://evil.test',Cookie:login.headers.get('set-cookie')!.split(';')[0]},body:'{}'});
    assert.equal(badOrigin.status,403);
    assert.equal((await req('/measurements','POST',{address:'Test address',areaSqFt:-1,pitch:6})).status,400);
    const measurement = await (await req('/measurements','POST',{address:'100 Test Lane, Austin TX',areaSqFt:2400,pitch:6,areaType:'surface',source:'manual'})).json();
    const input = {measurementId:measurement.id,previewPricebook:defaultPricebook,scope:{...defaultScope,areaSqFt:2400},customer:{name:'Test Customer',email:'test@example.com',phone:''},notes:'',review:{property:false,measurements:false,scope:false}};
    const response = await req('/quotes','POST',input); assert.equal(response.status,201);
    const quote = await response.json();
    assert.equal((await req(`/quotes/${quote.id}/status`,'PATCH',{status:'ready'})).status,409);
    const revised = await (await req(`/quotes/${quote.id}`,'PUT',{...input,review:{property:true,measurements:true,scope:true}})).json();
    assert.equal(revised.id,quote.id);
    assert.equal((await req(`/quotes/${quote.id}/status`,'PATCH',{status:'ready'})).status,200);
    assert.equal((await req(`/quotes/${quote.id}`,'PUT',input)).status,409);
    const pdf = await req(`/quotes/${quote.id}/pdf`); assert.equal(pdf.status,200); assert.equal((await pdf.text()).slice(0,4),'%PDF');
    const before = quote.calculation.totalCents;
    const settings = await (await req('/settings')).json();
    await req('/settings','PUT',{...settings,pricebook:{...settings.pricebook,laborPerSquare:999}});
    const stale=await req('/quotes','POST',{...input,review:{property:true,measurements:true,scope:true}});
    assert.equal(stale.status,409,'Saving a stale price preview must require recalculation and review');
    const stored = await (await req(`/quotes/${quote.id}`)).json(); assert.equal(stored.calculation.totalCents,before);
    assert.equal((await (await req('/customers')).json()).length,1);
    assert.equal((await req(`/quotes/${quote.id}/status`,'PATCH',{status:'accepted'})).status,409);
    assert.equal((await req(`/quotes/${quote.id}/status`,'PATCH',{status:'sent'})).status,200);
    assert.equal((await req(`/quotes/${quote.id}/status`,'PATCH',{status:'accepted'})).status,200);
    assert.ok((await (await req(`/quotes/${quote.id}/events`)).json()).length >= 4);
  } finally { server.close(); store.close(); }
});
