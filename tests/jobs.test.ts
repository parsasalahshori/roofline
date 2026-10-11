import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {JobService} from '../server/jobs.ts';
import {ProviderClient} from '../server/providers.ts';

test('confirmed address order is idempotent, then automatically produces a draft',async()=>{
 const store=new Store(':memory:');let orders=0;
 const provider=new ProviderClient({EAGLEVIEW_ACCESS_TOKEN:'test'},async(url)=>{
   if(String(url).includes('PriceOrder'))return Response.json({MinPrice:20,MaxPrice:30});
   if(String(url).includes('PlaceOrder')){orders++;return Response.json({OrderId:1,ReportIds:[123]});}
   return Response.json({ReportId:123,StatusId:5,Street:'100 Test Lane',City:'Austin',State:'TX',Zip:'78701',Area:'2400',Pitch:'6/12'});
 });
 const jobs=new JobService(store,provider);
 const input={street:'100 Test Lane',city:'Austin',state:'TX',zip:'78701',productId:1,deliveryId:8,includeGarage:false,changesInLast4Years:false,customer:{name:'Test Owner',email:'',phone:''},material:'architectural'};
 try{
  const price=await jobs.price(input);assert.equal(price.maxPriceCents,3000);
  await assert.rejects(jobs.order({priceId:price.id,acceptMaxPriceCents:2000,idempotencyKey:'test-request-123456'}),/price/i);
  const job=await jobs.order({priceId:price.id,acceptMaxPriceCents:3000,idempotencyKey:'test-request-123456'});
  const again=await jobs.order({priceId:price.id,acceptMaxPriceCents:3000,idempotencyKey:'test-request-123456'});
  assert.equal(job.id,again.id);assert.equal(orders,1);
  await jobs.poll();await jobs.poll();
  assert.equal(store.quotes().length,1);assert.equal(store.quotes()[0].status,'draft');
  assert.equal(store.quotes()[0].review.measurements,false);
  assert.equal(jobs.list()[0].status,'complete');
 }finally{store.close();}
});
