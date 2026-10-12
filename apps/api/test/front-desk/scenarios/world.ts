import type { FrontDeskToolName } from '@roofline/shared';
import type { Seed } from './types.ts';

/*
 * The live eval has no database, so it answers the tools from the scenario's seed with these doubles. Each reply
 * copies the shape of what the real handler returns to the model (apps/api/src/front-desk/tools/*), so the real
 * models see the same kind of text. What the real handlers do with rows (bookings, claims, scope, the gate) is proved
 * by CI against the database (call-paths.test.ts and scenarios.test.ts), not here.
 */

export const JOB_ID = '5a1f7c52-3c66-4b79-9a9a-1d2f8b2c0a11';
export const PROPERTY_ID = '7b2e8d63-4d77-4c8a-8b8b-2e3a9c3d1b22';
const INSPECTOR = '9c3f9e74-5e88-4d9b-9c9c-3f4bad4e2c33';

export type ToolReply = { ok: boolean; forModel: string; shownIds?: string[] };

const OFFERS = [
  { when: 'Wednesday the fourteenth at nine', start: '2026-10-14T14:00:00.000Z' },
  { when: 'Wednesday the fourteenth at ten thirty', start: '2026-10-14T15:30:00.000Z' },
  { when: 'Thursday the fifteenth at nine', start: '2026-10-15T14:00:00.000Z' },
  { when: 'Thursday the fifteenth at eleven', start: '2026-10-15T16:00:00.000Z' },
];

const line = (o: { when: string; start: string }) => `- ${o.when} with Sam (slotStart ${o.start}, slotUserId ${INSPECTOR})`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export type World = { run(name: FrontDeskToolName, input: unknown): ToolReply; readonly verified: boolean };

export function createWorld(seed: Seed): World {
  let verified = false;
  let slotTaken = false;

  const run = (name: FrontDeskToolName, input: unknown): ToolReply => {
    const i = (input ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'verify_caller': {
        if (seed.caller === 'unknown') {
          return { ok: false, forModel: 'There is no customer record for this phone number, so the caller cannot be verified. Offer to take a message or book a new inspection.' };
        }
        const who = norm(String(i.name ?? ''));
        const street = norm(String(i.street ?? ''));
        if (who.includes('nina') && who.includes('park') && street.startsWith('412 oak')) {
          verified = true;
          return { ok: true, forModel: 'The caller is verified. You may now share their job details.' };
        }
        return { ok: false, forModel: 'That did not match our records. Ask the caller to say their full name and the street address again.' };
      }
      case 'lookup_my_jobs': {
        if (!verified) return { ok: false, forModel: 'The caller must be verified first. Use verify_caller.' };
        return {
          ok: true,
          forModel: `Job ${JOB_ID} at 412 Oak St: in the inspection stage; the team is arranging the inspection. Next: none.`,
          shownIds: [JOB_ID, PROPERTY_ID],
        };
      }
      case 'find_inspection_times':
        return {
          ok: true,
          forModel: `Open inspection times (about an hour each). Offer two at a time, in words, not the codes.\nMorning:\n${OFFERS.slice(0, 3).map(line).join('\n')}\nAfternoon:\n${line(OFFERS[3]!)}`,
        };
      case 'book_inspection': {
        const start = String(i.slotStart ?? '');
        if (seed.takeSlotAfterFind && !slotTaken && start === OFFERS[0]!.start) {
          slotTaken = true;
          return {
            ok: false,
            forModel: `That time was just taken. Say so and offer these two instead, in words, not the codes:\n${line(OFFERS[1]!)}\n${line(OFFERS[2]!)}`,
          };
        }
        const offer = OFFERS.find((o) => o.start === start);
        if (!offer || (seed.takeSlotAfterFind && start === OFFERS[0]!.start)) {
          return { ok: false, forModel: 'That is not one of the times offered. Offer the times again.' };
        }
        return { ok: true, forModel: `Booked for ${offer.when} with Sam at ${String(i.address ?? 'the address')}. A confirmation text is on its way.` };
      }
      case 'take_claim_details':
        return { ok: true, forModel: 'Claim details saved. Tell the caller the team will follow up.' };
      case 'take_message':
        return { ok: true, forModel: 'Message saved. Tell the caller someone will get back to them.' };
      case 'transfer_to_person':
        return { ok: true, forModel: 'Tell the caller you are connecting them now.' };
      case 'end_call':
        return { ok: true, forModel: 'Say a short goodbye.' };
      default:
        return { ok: false, forModel: 'That is not available right now.' };
    }
  };
  return {
    run,
    get verified() {
      return verified;
    },
  };
}
