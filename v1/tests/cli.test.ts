import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {createApp} from '../server/app.ts';
import {defaultScope} from '../shared/pricing.ts';
const exec=promisify(execFile);
test('Node and built BuildCLI clients create, price and export the same quote',async()=>{
 const {app,store}=createApp({databasePath:':memory:',demo:false,adminEmail:'test@example.com',adminPassword:'test-password-12345',apiToken:'cli-test-token-abcdefghijklmnopqrstuvwxyz'});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const env={...process.env,ROOFLINE_URL:`http://127.0.0.1:${(server.address() as any).port}`,ROOFLINE_TOKEN:'cli-test-token-abcdefghijklmnopqrstuvwxyz'};
 const dir=await mkdtemp(join(tmpdir(),'roofline-cli-'));
 const node=(...args:string[])=>exec(process.execPath,['cli/roofline.mjs',...args],{env});
 try{
  assert.equal(JSON.parse((await node('health')).stdout).ok,true);
  assert.equal(JSON.parse((await node('sandbox-addresses')).stdout).length,100);
  const measurement=JSON.parse((await node('import','examples/measurement.json')).stdout);
  const request={measurementId:measurement.id,scope:defaultScope,customer:{name:'CLI Customer',email:'',phone:''},notes:'',review:{property:false,measurements:false,scope:false}};
  const path=join(dir,'request.json');await writeFile(path,JSON.stringify(request));
  const quote=JSON.parse((await node('quote',path)).stdout);assert.equal(quote.customer.name,'CLI Customer');
  const pdf=join(dir,'node.pdf');await node('export',quote.id,pdf);assert.equal((await readFile(pdf)).subarray(0,4).toString(),'%PDF');
  await assert.rejects(node('export',quote.id,pdf));
  await assert.rejects(exec(process.execPath,['cli/roofline.mjs','quotes'],{env:{...env,ROOFLINE_TOKEN:'wrong'}}));
  if(existsSync('.buildcli/plugins/roof.jar')){
    const cli=(...args:string[])=>exec('./scripts/buildcli',['roof',...args],{env});
    assert.equal(JSON.parse((await cli('health')).stdout).ok,true);
    assert.equal(JSON.parse((await cli('sandbox-addresses')).stdout).length,100);
    const estimate=JSON.parse((await cli('estimate','--file',path)).stdout);assert.equal(estimate.totalCents,quote.calculation.totalCents);
    const jpdf=join(dir,'java.pdf');await cli('export',quote.id,'--out',jpdf);assert.equal((await readFile(jpdf)).subarray(0,4).toString(),'%PDF');
    await assert.rejects(exec('./scripts/buildcli',['roof','quotes'],{env:{...env,ROOFLINE_TOKEN:'wrong'}}));
  }
 }finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}
});
