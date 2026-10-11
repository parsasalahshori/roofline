import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.ts';
import {pipelineSummary,nextStep,followUpLabel} from '../client/business.ts';
import type {FollowUp,Quote} from '../shared/types.ts';

test('open proposal value excludes accepted and declined work and labels practice data',()=>{
  const {store}=createApp({databasePath:':memory:',demo:true,adminEmail:'owner@example.com'});
  try{
    const example=store.quotes()[0];
    const quotes:Quote[]=['draft','ready','sent','accepted','declined'].map((status,i)=>({...example,status:status as Quote['status'],calculation:{...example.calculation,totalCents:(i+1)*10000}}));
    assert.deepEqual(pipelineSummary(quotes),{openCount:3,openCents:60000,acceptedCount:1,includesPractice:true});
    assert.equal(pipelineSummary(quotes.map(q=>({...q,measurement:{...q.measurement,source:'manual'}}))).includesPractice,false);
    assert.equal(nextStep({...example,status:'draft',review:{property:true,measurements:false,scope:false}}),'2 review checks remaining');
    assert.equal(nextStep({...example,measurement:{...example.measurement,source:'eagleview-sandbox'}}),'Practice draft');
  }finally{store.close();}
});
test('reminder labels compare calendar days across month and year boundaries',()=>{
  const reminder=(dueDate:string)=>({dueDate}) as FollowUp;
  assert.equal(followUpLabel(reminder('2026-12-31'),'2026-12-31'),'Today');
  assert.equal(followUpLabel(reminder('2027-01-01'),'2026-12-31'),'Tomorrow');
  assert.equal(followUpLabel(reminder('2026-12-30'),'2026-12-31'),'Overdue · Dec 30');
  assert.equal(followUpLabel(reminder('2027-01-05'),'2026-12-31'),'Jan 5');
});
