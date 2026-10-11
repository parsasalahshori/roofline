import {ArrowUpRight,CalendarDays,FileText,House,Plus} from 'lucide-react';
import type {FollowUp,Quote} from '../shared/types';
import {money} from '../shared/pricing';
import {formatDate} from '../shared/dates';
import {followUpLabel,isPractice,nextStep,stages,stageNames,streetName} from './business';

export function SalesBoard({quotes,followups=[],compact=false,onOpen,onFollowUp}:{quotes:Quote[];followups?:FollowUp[];compact?:boolean;onOpen:(q:Quote)=>void;onFollowUp?:(q:Quote)=>void}){
  const visibleStages=compact?stages.filter(s=>s!=='declined'||quotes.some(q=>q.status==='declined')):stages;
  return <div className={'sales-board '+(compact?'compact':'')} role="region" aria-label="Proposal job board">{visibleStages.map(status=>{
    const group=quotes.filter(q=>q.status===status);
    return <section className={'board-column stage-'+status} key={status} aria-label={stageNames[status]+' proposals'}><header><span className="stage-dot"/><h3>{stageNames[status]}</h3><span className="stage-count">{group.length}</span><small>{money(group.reduce((sum,q)=>sum+q.calculation.totalCents,0))}</small></header><div className="board-cards">{(compact?group.slice(0,2):group).map(q=>{
      const followup=followups.find(f=>f.quoteId===q.id&&!f.done);
      return <article className="job-card" key={q.id}><button className="job-card-open" aria-label={`Open ${q.number} for ${q.customer.name}`} onClick={()=>onOpen(q)}><div className="job-card-top"><span className="job-house"><House size={19}/></span><span className="job-number">{q.number}</span><ArrowUpRight size={15}/></div><h4>{streetName(q.measurement.address)}</h4><p>{q.customer.name}</p><strong className="job-value">{money(q.calculation.totalCents)}</strong><div className="job-tags">{isPractice(q)&&<span>Practice</span>}<small><FileText size={11}/>{nextStep(q)}</small></div></button>{!compact&&<div className="job-card-bottom">{followup?<button className="job-followup" onClick={()=>onFollowUp?.(q)} disabled={!onFollowUp}><CalendarDays size={12}/>{followUpLabel(followup)}</button>:<small>{formatDate(q.updatedAt).replace(/, \d{4}$/,'')}</small>}{onFollowUp&&<button className="job-add-followup" onClick={()=>onFollowUp(q)} aria-label={`Plan follow-up for ${q.number}`} title="Plan follow-up"><Plus size={14}/></button>}</div>}</article>;
    })}{!group.length&&<div className="board-empty"><span className="empty-stage-line"/><p>No proposals here yet.</p></div>}{compact&&group.length>2&&<p className="board-more">+{group.length-2} more proposal{group.length-2===1?'':'s'}</p>}</div></section>;
  })}</div>;
}
