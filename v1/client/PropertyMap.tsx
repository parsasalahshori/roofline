import {useEffect,useRef,useState} from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type {HailReport} from '../server/storms';
import {streetName} from './business';
export type PropertyPoint={address:string;lat:number;lon:number};
const homeIcon='<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true"><path d="M3 8.5 10 3l7 5.5V17H3Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 17v-6h4v6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
export function PropertyMap({properties,selected,onSelect,savedAddresses=[],reports=[],showStorms=false,fitStorms=0,fitProperties=0}:{properties:PropertyPoint[];selected:PropertyPoint|null;onSelect:(p:PropertyPoint)=>void;savedAddresses?:string[];reports?:HailReport[];showStorms?:boolean;fitStorms?:number;fitProperties?:number}){
  const element=useRef<HTMLDivElement>(null),map=useRef<L.Map|null>(null),propertyLayer=useRef<L.LayerGroup|null>(null),stormLayer=useRef<L.LayerGroup|null>(null),choose=useRef(onSelect);
  const [offline,setOffline]=useState(false);choose.current=onSelect;
  useEffect(()=>{
    if(!element.current)return;
    const m=L.map(element.current,{zoomControl:false,scrollWheelZoom:false}).setView([41.252,-95.997],14);map.current=m;
    L.control.zoom({position:'bottomleft'}).addTo(m);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).on('tileerror',()=>setOffline(true)).addTo(m);
    propertyLayer.current=L.layerGroup().addTo(m);stormLayer.current=L.layerGroup().addTo(m);
    const observer=new ResizeObserver(()=>m.invalidateSize({pan:false}));observer.observe(element.current);
    return()=>{observer.disconnect();m.remove();map.current=null;};
  },[]);
  useEffect(()=>{
    const layer=propertyLayer.current;if(!layer)return;layer.clearLayers();
    const saved=new Set(savedAddresses);
    properties.forEach(p=>{
      const isSelected=p.address===selected?.address,isSaved=saved.has(p.address),size=isSelected?28:isSaved?22:18;
      const icon=L.divIcon({className:'roof-pin '+(isSaved?'saved ':'')+(isSelected?'selected':''),html:homeIcon,iconSize:[size,size],iconAnchor:[size/2,size/2]});
      const marker=L.marker([p.lat,p.lon],{icon,title:p.address,alt:p.address,keyboard:true,zIndexOffset:isSelected?1000:isSaved?100:0}).addTo(layer).on('click',()=>choose.current(p));
      const label=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('small');
      name.textContent=streetName(p.address);detail.textContent=isSaved?'Saved property':'Omaha test property';label.append(name,detail);
      marker.bindTooltip(label,{direction:'top',offset:[0,-8],permanent:isSelected,className:'property-tooltip'});
    });
  },[properties,selected?.address,savedAddresses]);
  useEffect(()=>{if(selected)map.current?.flyTo([selected.lat,selected.lon],16,{duration:window.matchMedia('(prefers-reduced-motion:reduce)').matches?0:.5});},[selected]);
  useEffect(()=>{
    const layer=stormLayer.current;if(!layer)return;layer.clearLayers();
    if(showStorms)reports.forEach(r=>{
      const label=document.createElement('span');label.textContent=`${r.sizeInches?`${r.sizeInches} inch hail`:'Hail reported'} · ${r.location}, ${r.state}`;
      L.circleMarker([r.lat,r.lon],{radius:6+Math.min(r.sizeInches??1,4)*2,color:'#9a5d00',weight:1.5,fillColor:'#efb93b',fillOpacity:.85}).addTo(layer).bindTooltip(label);
    });
  },[reports,showStorms]);
  useEffect(()=>{if(!showStorms)map.current?.setView(selected?[selected.lat,selected.lon]:[41.252,-95.997],selected?16:14);},[showStorms]);
  useEffect(()=>{if(map.current&&fitStorms&&reports.length)map.current.fitBounds(L.latLngBounds(reports.map(r=>[r.lat,r.lon])),{padding:[50,50],maxZoom:10});},[fitStorms]);
  useEffect(()=>{if(map.current&&fitProperties&&properties.length)map.current.fitBounds(L.latLngBounds(properties.map(p=>[p.lat,p.lon])),{padding:[55,55],maxZoom:17});},[fitProperties]);
  return <><div ref={element} className="property-map" role="region" aria-label="Property map. Select an address pin to create an estimate."/>{offline&&<div className="map-offline">Street tiles could not load. You can still choose a property from the list.</div>}</>;
}
