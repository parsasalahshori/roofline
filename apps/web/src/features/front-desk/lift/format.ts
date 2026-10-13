import type { ConversationListItem } from '@roofline/shared';
import { frontDeskInbox } from '../../../copy/front-desk-inbox.ts';

const copy = frontDeskInbox.lift;

/** The chip a call row wears, from what the call came to. `tone` picks its color in the row's CSS. */
export type OutcomeChip = { label: string; tone: 'good' | 'warn' | 'plain' };

export function outcomeChip(item: ConversationListItem): OutcomeChip {
  const textBack = item.textBackSent === true || item.channel === 'sms';
  switch (item.outcome) {
    case 'spam':
      return { label: copy.chips.spam, tone: 'warn' };
    case 'booked':
    case 'confirmed':
    case 'moved':
      return { label: copy.chips.booked, tone: 'good' };
    case 'claim':
      return { label: copy.chips.claim, tone: 'plain' };
    case 'transferred':
      return { label: item.transferredToName ? copy.chips.sentTo(item.transferredToName) : copy.chips.sentToTeam, tone: 'plain' };
    case 'canceled':
      return { label: copy.chips.canceled, tone: 'plain' };
    case 'abandoned':
      return { label: item.textBackSent === true ? copy.chips.textBack : copy.chips.hungUp, tone: 'plain' };
    case 'message':
      return { label: textBack ? copy.chips.textBack : copy.chips.message, tone: 'plain' };
    default:
      return { label: textBack ? copy.chips.textBack : copy.chips.question, tone: 'plain' };
  }
}

/** Initials for the avatar: first letters of the first and last word of the name; "?" for an unknown caller. */
export function initialsOf(name: string | null): string {
  const words = (name ?? '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0]!)[0]!;
  const last = words.length > 1 ? Array.from(words[words.length - 1]!)[0]! : '';
  return (first + last).toLocaleUpperCase();
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

/** A call's length as m:ss; a text thread (or a call with no length yet) reads "Text". */
export function durationLabel(item: ConversationListItem): string {
  if (item.channel === 'sms' || item.durationSeconds === null || item.durationSeconds === undefined) return copy.textThread;
  const seconds = item.durationSeconds;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Milliseconds as seconds with one decimal: 800 is "0.8". */
export function secondsText(ms: number): string {
  return (Math.round(ms / 100) / 10).toFixed(1);
}
