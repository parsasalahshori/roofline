import {useRef,useState} from 'react';
import {ArrowRight,CalendarDays,Check,Clock3,Plus,X} from 'lucide-react';
import type {FollowUp,Quote} from '../shared/types';
import {businessDate,nextCalendarDate} from '../shared/dates';
import {api} from './api';
import {followUpLabel,isPractice,streetName} from './business';
import {Field} from './ui';
import {useDialog} from './useDialog';

export function FollowUps({items,quotes,onAdd,onEdit,onOpen,onChange,notify}:{items:FollowUp[];quotes:Quote[];onAdd:()=>void;onEdit:(f:FollowUp)=>void;onOpen:(q:Quote)=>void;onChange:()=>Promise<void>;notify:(s:string)=>void}){
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[all,setAll]=useState(false);
  const pending=items.filter(f=>!f.done&&quotes.some(q=>q.id===f.quoteId));
  const due=pending.filter(f=>f.dueDate<=businessDate()).length;
  const complete=async(f:FollowUp)=>{
    setBusy(f.id);setError('');
    try{await api('/followups/'+f.id,'PATCH',{done:true});await onChange();notify('Follow-up completed.');}catch(e){setError((e as Error).message);}finally{setBusy('');}
  };
  return <section className="card followup-panel"><div className="owner-card-heading"><div><span className="eyebrow">STAY ONE STEP AHEAD</span><h2>Don’t let a good lead go quiet.</h2><p>{due?`${due} follow-up${due===1?'':'s'} due today or earlier.`:'Your next calls and proposal checks, in one place.'}</p></div><button className="button secondary" disabled={!quotes.length} onClick={onAdd}><Plus size={16}/>Add follow-up</button></div>
    {pending.length?<div className="followup-list">{(all?pending:pending.slice(0,4)).map(f=>{const q=quotes.find(q=>q.id===f.quoteId)!;return <div className="followup-row" key={f.id}><button className={'followup-check '+(busy===f.id?'busy':'')} disabled={!!busy} onClick={()=>complete(f)} aria-label={`Complete follow-up for ${q.number}`} title="Mark complete"><Check size={15}/></button><button className="followup-property" onClick={()=>onOpen(q)}><strong>{q.customer.name}</strong><span>{f.note||'Check in about the proposal'}</span><small>{streetName(q.measurement.address)} · {q.number}{isPractice(q)?' · Practice':''}</small></button><button className={'followup-date '+(f.dueDate<businessDate()?'overdue':'')} onClick={()=>onEdit(f)} aria-label={`Reschedule follow-up for ${q.number}`}><Clock3 size={13}/>{followUpLabel(f)}</button></div>;})}</div>:<div className="followup-empty"><span><CalendarDays size={24}/></span><div><h3>A little planning goes a long way.</h3><p>Add a date to check in on a proposal. Your reminder will be waiting here.</p></div><ArrowRight size={18}/></div>}
    {error&&<p className="error" role="alert">{error}</p>}{pending.length>4&&<button className="text-button followup-show-all" onClick={()=>setAll(v=>!v)}>{all?'Show less':`Show all ${pending.length} follow-ups`}</button>}
  </section>;
}

export function FollowUpForm({quotes,quoteId,editing,onClose,onSaved}:{quotes:Quote[];quoteId?:string;editing?:FollowUp;onClose:()=>void;onSaved:()=>Promise<void>}){
  const ref=useRef<HTMLElement>(null);
  const [form,setForm]=useState({quoteId:editing?.quoteId??quoteId??quotes[0]?.id??'',dueDate:editing?.dueDate??nextCalendarDate(businessDate()),note:editing?.note??''});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useDialog(ref,()=>{if(!busy)onClose();});
  const submit=async()=>{
    if(!form.quoteId||!form.dueDate)return;
    setBusy(true);setError('');
    try{await api(editing?'/followups/'+editing.id:'/followups',editing?'PATCH':'POST',editing?{dueDate:form.dueDate,note:form.note}:form);await onSaved();onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <div className="modal-backdrop owner-modal-backdrop" onClick={()=>{if(!busy)onClose();}}><section ref={ref} className="modal followup-modal" role="dialog" aria-modal="true" aria-label={editing?'Edit follow-up':'Plan a follow-up'} onClick={e=>e.stopPropagation()}><div className="owner-modal-heading"><span className="owner-modal-icon"><CalendarDays size={23}/></span><button className="icon-btn" disabled={busy} aria-label="Close follow-up" onClick={onClose}><X size={20}/></button><div><span className="eyebrow">KEEP THE CONVERSATION GOING</span><h2>{editing?'Move the next step.':'Plan your next follow-up.'}</h2><p>A workspace reminder for you or your team.</p></div></div><form className="followup-form" onSubmit={e=>{e.preventDefault();submit();}}><Field label="Proposal"><select data-initial-focus required disabled={busy||!!editing} value={form.quoteId} onChange={e=>setForm({...form,quoteId:e.target.value})}>{quotes.map(q=><option value={q.id} key={q.id}>{q.number} · {q.customer.name}{isPractice(q)?' · Practice':''}</option>)}</select></Field><Field label="Follow-up date"><input data-initial-focus={editing?true:undefined} type="date" required disabled={busy} value={form.dueDate} onInput={e=>setForm({...form,dueDate:e.currentTarget.value})} onChange={e=>setForm({...form,dueDate:e.target.value})}/></Field><Field label="What’s the next step? (optional)"><textarea maxLength={500} rows={3} disabled={busy} value={form.note} onChange={e=>setForm({...form,note:e.target.value})} placeholder="Call about shingle color, check on a proposal…"/></Field>{error&&<p className="error" role="alert">{error}</p>}<button className="button primary full" disabled={busy||!form.quoteId}>{busy?'Saving…':editing?'Save follow-up':'Save reminder'}<ArrowRight size={16}/></button></form></section></div>;
}
