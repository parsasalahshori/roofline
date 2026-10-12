import { EmptyState } from '@roofline/ui';
import { frontDesk } from '../../../copy/front-desk.ts';

/** The Front Desk tab of Settings (a placeholder until the Front Desk settings arrive). */
export function FrontDeskTab() {
  return <EmptyState title={frontDesk.settingsEmpty} />;
}
