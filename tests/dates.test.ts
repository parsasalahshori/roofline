import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatDate,businessDate,nextCalendarDate,formatCalendarDate} from '../shared/dates.ts';
test('proposal date follows US Pacific across midnight UTC',()=>{
 assert.equal(formatDate('2026-10-07T02:00:00.000Z'),'Oct 6, 2026');
});
test('reminder dates use Pacific local days without shifting date-only values',()=>{
 assert.equal(businessDate('2026-10-07T02:00:00.000Z'),'2026-10-06');
 assert.equal(businessDate('2026-10-07T18:00:00.000Z'),'2026-10-07');
 assert.equal(nextCalendarDate('2026-12-31'),'2027-01-01');
 assert.equal(formatCalendarDate('2026-10-07'),'Oct 7');
});
