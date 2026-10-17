import type { MessageStatus } from '@roofline/shared';
import { frontDeskInbox } from './front-desk-inbox.ts';

/** The shared timeline (job window and customer window) and the note composer. */
export const timeline = {
  label: 'Timeline',
  empty: 'Nothing has happened yet.',
  emptyBody: 'Notes, texts, calls and moves show up here as they happen.',
  errorTag: "Couldn't load",
  loading: 'Loading timeline',
  loadFailed: "We couldn't load the timeline. Try again in a minute.",
  retry: 'Try again',
  showOlder: 'Show older',
  by: (name: string) => `by ${name}`,
  messageStatus: {
    scheduled: 'Scheduled',
    queued: 'Sending',
    sent: 'Sent',
    delivered: 'Delivered',
    failed: 'Not delivered',
    blocked: 'Not sent',
    received: 'Received',
  } satisfies Record<MessageStatus, string>,
  frontDesk: {
    callLabel: 'Front Desk call',
    textLabel: 'Front Desk text',
    open: 'Open conversation',
    outcome: frontDeskInbox.outcomes,
  },
  system: 'Roofline',
  noteLabel: 'Add a note',
  notePlaceholder: 'Write a note',
  noteAdd: 'Add note',
  noteMax: 2000,
  noteCounter: (used: number, max: number) => `${used.toLocaleString('en-US')} of ${max.toLocaleString('en-US')}`,
  noteTooLong: 'Write a note, up to 2,000 characters.',
  noteFailed: "We couldn't save that note. Try again.",
  justNow: 'just now',
  minutesAgo: (n: number) => (n === 1 ? '1 minute ago' : `${n} minutes ago`),
  hoursAgo: (n: number) => (n === 1 ? '1 hour ago' : `${n} hours ago`),
  daysAgo: (n: number) => (n === 1 ? '1 day ago' : `${n} days ago`),
} as const;
