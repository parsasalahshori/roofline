import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHailReports,getHailReports} from '../server/storms.ts';

const header='Time,Size,Location,County,State,Lat,Lon,Comments';
test('NOAA hail reports preserve coordinates, convert hundredths of an inch and keep comma-containing comments',()=>{
 const rows=parseHailReports(header+'\r\n1815,175,2 W Test Town,TEST,NE,41.25,-95.99,"Quarter and golf ball size, reported by spotter"\r\n1900,UNK,Test City,TEST,IA,42.1,-96.2,Size not known\r\n');
 assert.equal(rows.length,2);
 assert.deepEqual(rows[0],{time:'1815',sizeInches:1.75,location:'2 W Test Town',county:'TEST',state:'NE',lat:41.25,lon:-95.99,comments:'Quarter and golf ball size, reported by spotter'});
 assert.equal(rows[1].sizeInches,null);
 assert.deepEqual(parseHailReports(header+'\n'),[]);
});
test('invalid upstream files fail explicitly; malformed coordinates are excluded',()=>{
 assert.throws(()=>parseHailReports('<html>Not found</html>'),/temporarily unavailable/);
 assert.deepEqual(parseHailReports(header+'\n1800,100,Place,County,NE,abc,-95,Invalid\n1800,100,Place,County,NE,,0,Missing\n1800,100,Place,County,NE,99,0,Out of range\nshort,row'),[]);
});
test('impossible or future report dates are rejected before contacting NOAA',async()=>{
 for(const date of ['not-a-date','2026-02-30','2026-00-01','2026-13-01','2099-12-31'])await assert.rejects(getHailReports(date),/valid report date/);
});
