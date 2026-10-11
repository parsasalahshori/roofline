import {useEffect,useRef,type RefObject} from 'react';

export function useDialog(ref:RefObject<HTMLElement|null>,onClose:()=>void,enabled=true){
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    if(!enabled)return;
    const previous=document.activeElement as HTMLElement|null;
    const overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const controls=()=>Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')??[]).filter(el=>el.getClientRects().length>0);
    (ref.current?.querySelector<HTMLElement>('[data-initial-focus]:not(:disabled)')??controls()[0]??ref.current)?.focus({preventScroll:true});
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close.current();}
      if(event.key==='Tab'){
        const items=controls();const first=items[0],last=items.at(-1);
        if(!items.length){event.preventDefault();return;}
        if(!ref.current?.contains(document.activeElement)){event.preventDefault();(event.shiftKey?last:first)?.focus();}
        else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',keydown);
    return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',keydown);if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[enabled,ref]);
}
