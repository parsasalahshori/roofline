import type {FollowUp,Quote,Status} from '../shared/types';
import {businessDate,formatCalendarDate,nextCalendarDate} from '../shared/dates';

export const stages:Status[]=['draft','ready','sent','accepted','declined'];
export const stageNames:Record<Status,string>={draft:'Draft',ready:'Ready',sent:'Sent',accepted:'Accepted',declined:'Declined'};
export const streetName=(address:string)=>address.split(',')[0].toLowerCase().replace(/\b[a-z]/g,letter=>letter.toUpperCase());
export const isPractice=(q:Quote)=>q.measurement.source==='demo'||q.measurement.source==='eagleview-sandbox';
export function pipelineSummary(quotes:Quote[]){
  const open=quotes.filter(q=>['draft','ready','sent'].includes(q.status));
  return {openCount:open.length,openCents:open.reduce((sum,q)=>sum+q.calculation.totalCents,0),acceptedCount:quotes.filter(q=>q.status==='accepted').length,includesPractice:quotes.some(isPractice)};
}
export function nextStep(q:Quote){
  if(q.measurement.source==='eagleview-sandbox')return 'Practice draft';
  if(q.status==='draft'){
    const count=Object.values(q.review).filter(value=>!value).length;
    return count?`${count} review check${count===1?'':'s'} remaining`:'Ready for your final review';
  }
  return {ready:'Download PDF & share',sent:'Record the customer’s response',accepted:'Acceptance recorded',declined:'Closed proposal'}[q.status];
}
export function followUpLabel(f:FollowUp,today=businessDate()){
  if(f.dueDate<today)return 'Overdue · '+formatCalendarDate(f.dueDate);
  if(f.dueDate===today)return 'Today';
  if(f.dueDate===nextCalendarDate(today))return 'Tomorrow';
  return formatCalendarDate(f.dueDate);
}
