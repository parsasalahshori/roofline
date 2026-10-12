import type { PriorTool } from './types.ts';

const SLOT = /slotStart (\S+), slotUserId ([0-9a-f-]{36})/;

/** The first time offered in the latest tool result that offers any (find_inspection_times, or a refused booking). */
export function offeredSlot(prior: readonly PriorTool[]): { slotStart: string; slotUserId: string } {
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = SLOT.exec(prior[i]!.result);
    if (m) return { slotStart: m[1]!, slotUserId: m[2]! };
  }
  throw new Error('No inspection time was offered earlier in this scripted call.');
}

/** The first time offered by the first tool result that offers any (the one the caller was first told about). */
export function firstOfferedSlot(prior: readonly PriorTool[]): { slotStart: string; slotUserId: string } {
  for (const p of prior) {
    const m = SLOT.exec(p.result);
    if (m) return { slotStart: m[1]!, slotUserId: m[2]! };
  }
  throw new Error('No inspection time was offered earlier in this scripted call.');
}

export const ADDRESS = '123 Elm St, Omaha, NE 68102';
export const HOME_STREET = '412 Oak St';
