import { type FrontDeskToolName, FRONT_DESK_TOOLS, TEXT_CHANNEL_TOOLS } from '@roofline/shared';
import type { ToolHandlers } from '../engine-types.ts';
import { bookInspection } from './book.ts';
import { verifyCaller } from './caller.ts';
import { confirmAppointmentTool } from './confirm.ts';
import { endCall } from './end.ts';
import { checkForecast } from './forecast.ts';
import { hailAtMyHome } from './hail.ts';
import { lookupMyJobs } from './jobs.ts';
import { takeClaimDetails } from './claim.ts';
import { takeMessage } from './message.ts';
import { cancelInspection, isCancelAvailable, isMoveAvailable, moveInspection } from './move.ts';
import { findInspectionTimes, isAvailable as isTimesAvailable } from './times.ts';
import { transferToPerson } from './transfer.ts';

/** Every Front Desk tool handler, keyed by tool name. The engine and the text runner filter it per call. */
export const FRONT_DESK_HANDLERS: ToolHandlers = {
  lookup_my_jobs: lookupMyJobs,
  verify_caller: verifyCaller,
  check_forecast: checkForecast,
  hail_at_my_home: hailAtMyHome,
  find_inspection_times: findInspectionTimes,
  book_inspection: bookInspection,
  confirm_appointment: confirmAppointmentTool,
  move_inspection: moveInspection,
  cancel_inspection: cancelInspection,
  take_claim_details: takeClaimDetails,
  take_message: takeMessage,
  transfer_to_person: transferToPerson,
  end_call: endCall,
};

export type ToolSettings = { canMove: boolean; canCancel: boolean };

const AVAILABLE: Partial<Record<FrontDeskToolName, (s: ToolSettings) => boolean>> = {
  find_inspection_times: isTimesAvailable,
  book_inspection: isTimesAvailable,
  confirm_appointment: isTimesAvailable,
  move_inspection: isMoveAvailable,
  cancel_inspection: isCancelAvailable,
};

/** The tools offered on a channel under the company's settings. Alphabetical, so the tool list bytes never change (cache prefix). */
export function toolNamesFor(channel: 'voice' | 'sms', settings: ToolSettings): FrontDeskToolName[] {
  const all = Object.keys(FRONT_DESK_TOOLS) as FrontDeskToolName[];
  const names = channel === 'sms' ? all.filter((n) => TEXT_CHANNEL_TOOLS.includes(n)) : all;
  return names.filter((n) => AVAILABLE[n]?.(settings) ?? true).sort();
}

export function handlersFor(channel: 'voice' | 'sms', settings: ToolSettings): ToolHandlers {
  const out: Record<string, unknown> = {};
  for (const name of toolNamesFor(channel, settings)) out[name] = FRONT_DESK_HANDLERS[name];
  return out as ToolHandlers;
}
