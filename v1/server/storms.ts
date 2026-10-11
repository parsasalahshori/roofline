import {AppError} from './errors.ts';
export type HailReport={time:string;sizeInches:number|null;location:string;county:string;state:string;lat:number;lon:number;comments:string};
export function parseHailReports(csv:string):HailReport[]{
 const lines=csv.trim().split(/\r?\n/);if(lines[0]?.trim()!=='Time,Size,Location,County,State,Lat,Lon,Comments')throw new AppError(502,'Storm reports are temporarily unavailable. Your saved properties are still here.');
 return lines.slice(1).flatMap(line=>{const cells=line.split(',');if(cells.length<8)return [];const [time,size,location,county,state,latitude,longitude,...comments]=cells;const lat=Number(latitude),lon=Number(longitude),magnitude=Number(size);if(!latitude||!longitude||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return [];return [{time,sizeInches:size!=='UNK'&&Number.isFinite(magnitude)&&magnitude>0?magnitude/100:null,location,county,state,lat,lon,comments:comments.join(',').replace(/^"|"$/g,'')}];});
}
const cache=new Map<string,{at:number;reports:HailReport[]}>();
export async function getHailReports(date:string){
 if(!/^20\d{2}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T12:00:00Z'))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date||date>new Date().toISOString().slice(0,10))throw new AppError(400,'Choose a valid report date up to today.');
 const code=date.replaceAll('-','').slice(2),sourceUrl=`https://www.spc.noaa.gov/climo/reports/${code}_rpts.html`;
 let cached=cache.get(date);
 if(!cached||Date.now()-cached.at>10*60*1000){
  try{const r=await fetch(`https://www.spc.noaa.gov/climo/reports/${code}_rpts_hail.csv`,{signal:AbortSignal.timeout(12000),headers:{'User-Agent':'Roofline/1.0 (local roofing workspace)'}});if(!r.ok)throw Error();cached={at:Date.now(),reports:parseHailReports(await r.text())};if(cache.size>=32)cache.delete(cache.keys().next().value!);cache.set(date,cached);}
  catch{throw new AppError(502,'Storm reports are temporarily unavailable. Try another date or continue with a property.');}
 }
 return {date,source:'NOAA Storm Prediction Center',sourceUrl,reports:cached.reports,checkedAt:new Date(cached.at).toISOString(),note:'Preliminary hail reports, from 12:00 UTC on this date to 12:00 UTC the next day. Report locations do not confirm roof damage.'};
}
