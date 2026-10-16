import type { ConversationListItem } from '@roofline/shared';
import type { IconName, TagTone } from '@roofline/ui';
import { conversationCopy } from '../../copy/front-desk-conversation.ts';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { formatDayLabel, formatTime, zonedDateKey } from '../calendar/time.ts';

const copy = frontDeskInbox;

/** The tag a call wears, from what the call came to: its words, its status colour and its glyph (a status is never only a colour). */
export type OutcomeChip = {
  label: string;
  tone: TagTone;
  icon: IconName;
};

/** What a chip is worked out from. A list row and the open conversation both fit it. */
export type ChipSource = Pick<ConversationListItem, 'outcome' | 'channel'> &
  Partial<Pick<ConversationListItem, 'textBackSent' | 'transferredToName'>>;

export function outcomeChip(item: ChipSource): OutcomeChip {
  const textBack = item.textBackSent === true || item.channel === 'sms';
  switch (item.outcome) {
    case 'spam':
      return { label: copy.chips.spam, tone: 'warn', icon: 'lock' };
    case 'booked':
    case 'confirmed':
    case 'moved':
      return { label: copy.chips.booked, tone: 'ok', icon: 'cal' };
    case 'claim':
      return { label: copy.chips.claim, tone: 'info', icon: 'doc' };
    case 'transferred':
      return {
        label: item.transferredToName ? copy.chips.sentTo(item.transferredToName) : copy.chips.sentToTeam,
        tone: 'neutral',
        icon: 'users',
      };
    case 'canceled':
      return { label: copy.chips.canceled, tone: 'neutral', icon: 'x' };
    case 'abandoned':
      return {
        label: item.textBackSent === true ? copy.chips.textBack : copy.chips.hungUp,
        tone: 'neutral',
        icon: item.textBackSent === true ? 'msg' : 'phone',
      };
    case 'message':
      return {
        label: textBack ? copy.chips.textBack : copy.chips.message,
        tone: 'neutral',
        icon: textBack ? 'msg' : 'inbox',
      };
    default:
      return {
        label: textBack ? copy.chips.textBack : copy.chips.question,
        tone: 'neutral',
        icon: 'msg',
      };
  }
}

/** "14 min ago", "1 hr ago", "2 days ago". */
export function relativeTime(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return copy.time.justNow;
  if (minutes < 60) return copy.time.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return copy.time.hours(hours);
  return copy.time.days(Math.floor(hours / 24));
}

/** A length in seconds as m:ss; a length that is not a number reads 0:00. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** A call's length as m:ss; a text thread (or a call with no length yet) reads "Text". */
export function durationLabel(item: ConversationListItem): string {
  if (item.channel === 'sms' || item.durationSeconds === null || item.durationSeconds === undefined) return copy.textThread;
  return clock(item.durationSeconds);
}

/** Milliseconds as seconds with one decimal: 800 is "0.8". */
export function secondsText(ms: number): string {
  return (Math.round(ms / 100) / 10).toFixed(1);
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** "Oct 9" in the company zone. */
function shortDate(date: Date, zone: string): string {
  let formatter = dateFormatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' });
    dateFormatters.set(zone, formatter);
  }
  return formatter.format(date);
}

/** How many calendar days `earlier` ("YYYY-MM-DD") is before `later`. */
function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

/** "Today at 12:20 PM", "Yesterday at ...", or "Oct 9 at ..." on the company's own clock. */
export function whenLabel(iso: string, now: Date, zone: string): string {
  const at = new Date(iso);
  const time = formatTime(at, zone);
  const days = daysBetween(zonedDateKey(at, zone), zonedDateKey(now, zone));
  if (days === 0) return conversationCopy.today(time);
  if (days === 1) return conversationCopy.yesterday(time);
  return conversationCopy.onDate(shortDate(at, zone), time);
}

/** The clock time of a text line on the company's own clock: "12:20 PM". */
export function timeOfDay(iso: string, zone: string): string {
  return formatTime(new Date(iso), zone);
}

/** The company-zone day of a line ("2026-10-16"): a new key starts a new day in the thread. */
export function dayKey(iso: string, zone: string): string {
  return zonedDateKey(new Date(iso), zone);
}

/** The day heading of a line in the thread: "Fri, Oct 16" in the company zone. */
export function dayLabel(iso: string, zone: string): string {
  return formatDayLabel(new Date(iso), zone);
}

/** How far into the call a line was spoken, as m:ss: the same clock the recording plays on. */
export function offsetLabel(turnAt: string, callStartedAt: string): string {
  return clock((Date.parse(turnAt) - Date.parse(callStartedAt)) / 1000);
}
