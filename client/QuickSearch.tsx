import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {ArrowUpRight,BookOpen,CalendarDays,CornerDownLeft,FileText,House,LayoutGrid,MapPin,Search,Settings,X} from 'lucide-react';
import type {Quote} from '../shared/types';
import {api} from './api';
import type {PropertyPoint} from './PropertyMap';
import {streetName} from './business';
import {useDialog} from './useDialog';

type SearchPage='overview'|'proposals'|'pricebook'|'settings'|'connectors';
type Result={id:string;group:string;title:string;subtitle:string;icon:typeof House;run:()=>void};
export function QuickSearch({quotes,onClose,onNavigate,onEstimate,onProposal,onProperty,onFollowUp}:{quotes:Quote[];onClose:()=>void;onNavigate:(p:SearchPage)=>void;onEstimate:()=>void;onProposal:(q:Quote)=>void;onProperty:(p:PropertyPoint)=>void;onFollowUp:()=>void}){
  const ref=useRef<HTMLElement>(null),listId=useId();
  const [query,setQuery]=useState(''),[selected,setSelected]=useState(0),[properties,setProperties]=useState<PropertyPoint[]>([]),[saved,setSaved]=useState<PropertyPoint[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  useDialog(ref,onClose);
  useEffect(()=>{let active=true;Promise.all([api<PropertyPoint[]>('/sandbox/properties'),api<PropertyPoint[]>('/leads')]).then(([p,s])=>{if(active){setProperties(p);setSaved(s);}}).catch(()=>{if(active)setError('Property search is unavailable right now. Your proposals and shortcuts are still here.');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  const results=useMemo(()=>{
    const text=query.trim().toLowerCase(),match=(s:string)=>!text||s.toLowerCase().includes(text);
    const actions:Result[]=[
      {id:'new',group:'Shortcuts',title:'New estimate',subtitle:'Start a guided estimate',icon:House,run:onEstimate},
      {id:'board',group:'Shortcuts',title:'Open job board',subtitle:'See your proposals and next steps',icon:LayoutGrid,run:()=>onNavigate('proposals')},
      {id:'follow',group:'Shortcuts',title:'Plan a follow-up',subtitle:'Remember your next call or proposal check',icon:CalendarDays,run:onFollowUp},
      {id:'pricing',group:'Shortcuts',title:'Set my pricing',subtitle:'Materials, labor and allowances',icon:BookOpen,run:()=>onNavigate('pricebook')},
      {id:'settings',group:'Shortcuts',title:'Company settings',subtitle:'Personalize your proposals',icon:Settings,run:()=>onNavigate('settings')}
    ];
    const quoteResults:Result[]=quotes.filter(q=>match(`${q.number} ${q.customer.name} ${q.measurement.address}`)).slice(0,text?5:2).map(q=>({id:q.id,group:'Proposals',title:q.customer.name,subtitle:`${q.number} · ${streetName(q.measurement.address)}`,icon:FileText,run:()=>onProposal(q)}));
    const propertyResults:Result[]=(text?properties:saved).filter(p=>match(p.address)).slice(0,6).map(p=>({id:p.address,group:text?'Test properties':'Saved properties',title:streetName(p.address),subtitle:'Omaha, NE · View on map',icon:MapPin,run:()=>onProperty(p)}));
    return [...actions.filter(a=>match(a.title+' '+a.subtitle)),...quoteResults,...propertyResults];
  },[query,quotes,properties,saved,onNavigate,onEstimate,onProposal,onProperty,onFollowUp]);
  useEffect(()=>{setSelected(0);},[query]);
  useEffect(()=>{document.getElementById(listId+'-'+selected)?.scrollIntoView({block:'nearest'});},[selected,listId]);
  const choose=(item:Result)=>{onClose();item.run();};
  return <div className="modal-backdrop quick-search-backdrop" onClick={onClose}><section ref={ref} className="quick-search-panel" role="dialog" aria-modal="true" aria-label="Quick search" onClick={e=>e.stopPropagation()}><div className="quick-search-input"><Search size={22}/><input data-initial-focus role="combobox" aria-label="Search your workspace" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={results.length?listId+'-'+Math.min(selected,results.length-1):undefined} placeholder="Find a property, customer or proposal…" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setSelected(n=>Math.max(0,Math.min(results.length-1,n+(e.key==='ArrowDown'?1:-1))));}if(e.key==='Enter'&&results[selected]){e.preventDefault();choose(results[selected]);}}}/><button className="icon-btn" aria-label="Close quick search" onClick={onClose}><X size={19}/></button></div><div className="quick-search-results" role="listbox" id={listId} aria-label="Workspace results">{results.map((item,i)=><div key={item.id}>{(i===0||results[i-1].group!==item.group)&&<div className="quick-search-group">{item.group}</div>}<button id={listId+'-'+i} role="option" aria-selected={selected===i} className={'quick-search-result '+(selected===i?'selected':'')} onMouseEnter={()=>setSelected(i)} onClick={()=>choose(item)}><span><item.icon size={18}/></span><div><strong>{item.title}</strong><small>{item.subtitle}</small></div><ArrowUpRight size={15}/></button></div>)}{!results.length&&<p className="quick-search-empty">No matches yet. Try a street name, customer or proposal number.</p>}{error&&<p className="quick-search-error">{error}</p>}</div><footer><span>{loading?'Loading properties…':'Your workspace, one search away.'}</span><span><kbd>↑</kbd><kbd>↓</kbd> to browse <CornerDownLeft size={12}/> to open</span></footer></section></div>;
}
