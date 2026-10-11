import {useEffect,useState} from 'react';
import {ArrowRight,Info} from 'lucide-react';
import type {Measurement} from '../shared/types';
import {api} from './api';
import {Badge,Field} from './ui';
type Job={id:string;address:string;status:'pending'|'complete';roofs?:{index:number;measurement?:{areaSqFt:number;pitch:number;address:string};error?:string}[]};
export function SandboxLookup({configured,onSelect,initialAddress}:{initialAddress?:string;configured:boolean;onSelect:(m:Measurement)=>void}){
 const [properties,setProperties]=useState<{address:string}[]>([]),[address,setAddress]=useState(''),[job,setJob]=useState<Job|null>(null),[recent,setRecent]=useState<Job[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pollRound,setPollRound]=useState(0),[paused,setPaused]=useState(false);
 useEffect(()=>{let active=true;Promise.all([api<{address:string}[]>('/sandbox/properties'),api<Job[]>('/sandbox/requests')]).then(([p,r])=>{if(active){setProperties(p);setAddress(initialAddress&&p.some(x=>x.address===initialAddress)?initialAddress:p[0]?.address??'');setRecent(r);const a=initialAddress&&p.some(x=>x.address===initialAddress)?initialAddress:p[0]?.address;setJob(r.find(j=>j.address.toUpperCase()===a?.toUpperCase()&&j.status==='complete')??null);}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
 useEffect(()=>{
  if(!job||job.status!=='pending')return;
  let active=true,timer:ReturnType<typeof setTimeout>,attempts=0;setPaused(false);
  const poll=async()=>{try{const next=await api<Job>(`/sandbox/requests/${job.id}`);if(!active)return;setJob(next);if(next.status==='pending'){if(++attempts<18)timer=setTimeout(poll,10000);else setPaused(true);}}catch(e){if(active){setError((e as Error).message);setPaused(true);}}};
  timer=setTimeout(poll,1000);return()=>{active=false;clearTimeout(timer);};
 },[job?.id,job?.status,pollRound]);
 const start=async()=>{setBusy(true);setError('');try{const next=await api<Job>('/sandbox/requests','POST',{address});setJob(next);setRecent(r=>[next,...r].slice(0,10));}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const select=async(index:number)=>{if(!job)return;setBusy(true);setError('');try{onSelect(await api<Measurement>(`/sandbox/requests/${job.id}/select`,'POST',{index}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <div className="lookup-body"><div className="card-heading"><div><h2>Try a connected test property.</h2><p>Choose an Omaha property. We’ll get its roof measurements for you.</p></div><Badge tone="demo">Test properties</Badge></div>
 <div className="test-mode-note"><Info size={17}/><span>This is your test area. You can create practice proposals here. Live customer addresses will be available after production access is approved.</span></div>
 {!configured&&<div className="notice gold-notice"><Info size={18}/><span>Your measurement connection needs setup. Open Connections or use measurements you already have.</span></div>}
 <Field label="Choose a test property"><select value={address} disabled={busy} onChange={e=>{setAddress(e.target.value);setJob(recent.find(j=>j.address.toUpperCase()===e.target.value.toUpperCase()&&j.status==='complete')??null);setError('');}}>{properties.map(p=><option key={p.address}>{p.address}</option>)}</select></Field>
 <button className="button primary" disabled={busy||!address||!configured||!!job&&job.status==='pending'&&!paused} onClick={start}>{busy?'Getting measurements…':job?.status==='complete'?'Refresh measurements':'Get roof measurements'}<ArrowRight size={16}/></button>
 <a className="text-button" href="https://developer.eagleview.com/documentation/property-data/v2/sandbox#sandbox-subset" target="_blank" rel="noreferrer">About the test area ↗</a>
 {error&&<div className="error" role="alert">{error}</div>}
 {job&&<section className="sandbox-results" aria-live="polite"><h3>{job.address}</h3>{job.status==='pending'?<><p>{paused?'Checking paused. The saved request can be checked again.':'Getting your roof measurements. This may take a moment…'}</p>{paused&&<button className="button secondary" onClick={()=>{setError('');setPollRound(n=>n+1);}}>Resume checking</button>}</>:<><p>We found the roofs below. Choose the building you want to estimate.</p>{job.roofs?.map(r=><div className="candidate" key={r.index}><span><strong>Roof {r.index+1}</strong><small>{r.measurement?`${r.measurement.address} · ${r.measurement.areaSqFt.toLocaleString()} sq ft · ${r.measurement.pitch}/12 pitch`:r.error}</small></span>{r.measurement&&<button className="button secondary" disabled={busy} onClick={()=>select(r.index)}>Use roof {r.index+1}<ArrowRight size={14}/></button>}</div>)}</>}</section>}
 {recent.length>0&&<details className="scope-details"><summary>Recent properties</summary>{recent.map(r=><button className="candidate" disabled={busy} key={r.id} onClick={()=>{setJob(r);setAddress(r.address);setError('');setPollRound(n=>n+1);}}><span><strong>{r.address}</strong><small>{r.status==='complete'?'Measurements ready':'Measurements requested'}</small></span><ArrowRight size={16}/></button>)}</details>}
 </div>;
}
