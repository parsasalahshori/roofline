import type { TagTone } from '@roofline/ui';
import type { IconName } from '@roofline/ui';
import { storm } from '../../copy/storm.ts';

export type PlanTag = { label: string; tone: TagTone; icon: IconName };

/**
 * The plan's state as a tag: a word, a glyph and a tone. Waiting for a yes is the tape yellow of every "needs your OK";
 * a plan that has gone out is blue; one that finished is green; one that stopped part way or needs a look is amber;
 * one that was declined, ran out of time or never existed is quiet. Red is for errors, and none of these is one.
 */
export function planTag(status: string | null): PlanTag {
  switch (status) {
    case 'draft':
    case 'awaiting_owner':
      return { label: storm.planStatus.draft, tone: 'tape', icon: 'alert' };
    case 'approved':
      return { label: storm.planStatus.approved, tone: 'info', icon: 'check' };
    case 'running':
      return { label: storm.planStatus.running, tone: 'info', icon: 'refresh' };
    case 'done':
      return { label: storm.planStatus.done, tone: 'ok', icon: 'check' };
    case 'partly_done':
      return { label: storm.planStatus.partly_done, tone: 'warn', icon: 'alert' };
    case 'needs_attention':
      return { label: storm.planStatus.needs_attention, tone: 'warn', icon: 'alert' };
    case 'declined':
      return { label: storm.planStatus.declined, tone: 'neutral', icon: 'x' };
    case 'expired':
      return { label: storm.planStatus.expired, tone: 'neutral', icon: 'clock' };
    default:
      return { label: storm.noPlan, tone: 'neutral', icon: 'dots' };
  }
}
