#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
const [command,...args]=process.argv.slice(2);
const usage=`Roofline CLI — the roofing quote API from your terminal
Usage: node cli/roofline.mjs <command> [arguments]
  health                         Check server health (no token needed)
  connectors                     Inspect server connector configuration
  geocode "Street, City, ST ZIP"  Locate a property (requires Google key)
  sandbox-addresses              List supported Omaha sandbox properties
  sandbox-request "address"      Request roof data for a listed sandbox address
  sandbox-result <request-id>     Check a saved request (safe to repeat)
  sandbox-select <id> <index>     Import a structure (zero-based index)
  report <report-id>              Retrieve a completed EagleView roof report
  import <measurement.json>      Import normalized roof measurements
  estimate <scope.json>           Calculate line items without saving a quote
  quote <quote-request.json>      Save a draft proposal
  quotes                         List saved proposals
  export <quote-id> <file.pdf>    Download a proposal PDF
  batch <requests.json>           Save up to 100 quote requests; report per-item errors
Environment: ROOFLINE_URL (default http://127.0.0.1:4311), ROOFLINE_TOKEN
Token is passed in a header, never the URL. See docs/CLI.md.`;
if(!command||['help','--help','-h'].includes(command)){console.log(usage);process.exit(0);}
const root=new URL(process.env.ROOFLINE_URL??'http://127.0.0.1:4311');
async function request(path,method='GET',body){
  if(!['http:','https:'].includes(root.protocol)||root.username||root.password)throw Error('ROOFLINE_URL must be an HTTP(S) URL without credentials.');
  if(root.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(root.hostname))throw Error('Use HTTPS for remote servers.');
  const token=process.env.ROOFLINE_TOKEN;
  if(command!=='health'&&!token)throw Error('Set ROOFLINE_TOKEN to the server API_TOKEN.');
  const r=await fetch(new URL('/api'+path,root),{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!r.ok){const d=await r.json().catch(()=>({error:`HTTP ${r.status}`}));throw Error(d.error);}
  return r;
}
const file=async(name)=>{if(!name)throw Error('A JSON file path is required.');return JSON.parse(await readFile(name,'utf8'));};
const required=(value,name)=>{if(!value)throw Error(`${name} is required.`);return value;};
try{
  let result;
  switch(command){
    case 'health':result=await(await request('/health')).json();break;
    case 'connectors':result=await(await request('/connectors')).json();break;
    case 'quotes':result=await(await request('/quotes')).json();break;
    case 'geocode':result=await(await request('/lookup/geocode','POST',{address:required(args[0],'Address')})).json();break;
    case 'sandbox-addresses':result=await(await request('/sandbox/properties')).json();break;
    case 'sandbox-request':result=await(await request('/sandbox/requests','POST',{address:required(args[0],'Address')})).json();break;
    case 'sandbox-result':result=await(await request('/sandbox/requests/'+encodeURIComponent(required(args[0],'Request ID')))).json();break;
    case 'sandbox-select':result=await(await request('/sandbox/requests/'+encodeURIComponent(required(args[0],'Request ID'))+'/select','POST',{index:Number(required(args[1],'Structure index'))})).json();break;
    case 'report':result=await(await request('/lookup/eagleview','POST',{reportId:required(args[0],'Report ID')})).json();break;
    case 'import':result=await(await request('/measurements','POST',{...await file(args[0]),source:'import'})).json();break;
    case 'estimate':result=await(await request('/estimate','POST',await file(args[0]))).json();break;
    case 'quote':result=await(await request('/quotes','POST',await file(args[0]))).json();break;
    case 'export':{const id=required(args[0],'Quote ID'),out=required(args[1],'Output path');const r=await request(`/quotes/${encodeURIComponent(id)}/pdf`);await writeFile(out,Buffer.from(await r.arrayBuffer()),{flag:'wx'});result={saved:out};break;}
    case 'batch':{const values=await file(args[0]);if(!Array.isArray(values)||values.length>100)throw Error('Batch must be an array of at most 100 quote requests.');result=[];for(let i=0;i<values.length;i++){try{result.push({index:i,ok:true,quote:await(await request('/quotes','POST',values[i])).json()});}catch(e){result.push({index:i,ok:false,error:e.message});process.exitCode=1;}}break;}
    default:throw Error(`Unknown command: ${command}. Run --help.`);
  }
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
