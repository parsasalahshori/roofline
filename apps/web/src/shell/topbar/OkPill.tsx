import { Pill } from '@roofline/ui';
import { useApprovals } from '../../api/hooks.ts';
import { shell } from '../../copy/shell.ts';
import { countedDrafts } from '../countedDrafts.ts';

/**
 * "N need your OK": shown while drafts wait for a yes. With one draft it opens that draft; with
 * several it opens the list. The number is the drafts that count, not the server's own count.
 */
export function OkPill() {
  const drafts = countedDrafts(useApprovals().data);
  if (drafts.length === 0) return null;
  const [only] = drafts;
  const href = drafts.length === 1 && only ? '/approvals/' + encodeURIComponent(only.id) : '/approvals';
  return <Pill href={href}>{shell.needYourOk(drafts.length)}</Pill>;
}
