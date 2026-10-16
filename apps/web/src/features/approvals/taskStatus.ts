import type { TaskStatus } from '@roofline/shared';
import type { IconName, TagTone } from '@roofline/ui';

/**
 * How a plan's status is drawn: a tone and a glyph for its words. Tape yellow is for a plan that needs a person's OK;
 * green is done; blue is a plan at work; amber is a plan that ran out of time or needs a look; a plan set aside is plain.
 */
export const TASK_TAG: Record<TaskStatus, { tone: TagTone; icon: IconName }> = {
  draft: { tone: 'tape', icon: 'alert' },
  awaiting_owner: { tone: 'tape', icon: 'alert' },
  approved: { tone: 'ok', icon: 'check' },
  declined: { tone: 'neutral', icon: 'minus' },
  expired: { tone: 'warn', icon: 'clock' },
  running: { tone: 'info', icon: 'refresh' },
  done: { tone: 'ok', icon: 'check' },
  partly_done: { tone: 'warn', icon: 'alert' },
  needs_attention: { tone: 'warn', icon: 'alert' },
};
