import { useParams } from 'react-router';
import { EmptyState, Panel } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { useDemoMode } from '../demo/api.ts';
import { useConversation, useMarkReadOnOpen } from './conversation-api.ts';
import { CallDetail } from './detail/CallDetail.tsx';
import { InboxList } from './InboxList.tsx';
import { KpiStrip } from './KpiStrip.tsx';
import { FrontDeskStatus, SimulateCallButton } from './PageHead.tsx';
import styles from './FrontDeskWindow.module.css';

const copy = frontDeskInbox;

/** What the right pane says before a call is picked: the sentence, and the shape of what will fill it. */
function PickCall() {
  return (
    <Panel as="section" padded className={styles.pick}>
      <EmptyState title={copy.pickCall} body={copy.pickCallHint} />
      <div className={styles.ghostBubbles} aria-hidden="true">
        <span className={styles.ghostBubble} data-side="left" />
        <span className={styles.ghostBubble} data-side="right" />
        <span className={styles.ghostBubble} data-side="left" />
      </div>
    </Panel>
  );
}

/**
 * Front Desk: the number it answers and today's numbers under the page's title, over the latest calls on the left and the one that
 * was picked on the right. `/front-desk/:conversationId` picks a call. On a phone the list and the call take turns, and an open
 * call is a page of its own with "Front Desk" as the way back.
 */
export function FrontDeskWindow() {
  const { conversationId } = useParams();
  useMarkReadOnOpen(conversationId ?? '');
  const open = conversationId !== undefined;
  const phone = useIsPhone();
  const demo = useDemoMode();
  // Today's numbers are for the owner and the office (the server refuses a rep), so a rep never asks.
  const role = useMe().data?.role;
  const showStats = role === 'owner' || role === 'office';
  // The trail ends in the person's name once the call has loaded (the same read the call itself makes)
  const conversation = useConversation(conversationId);
  const name = conversation.data === undefined ? copy.conversation : (conversation.data.customer?.name ?? copy.unknownCaller);
  const crumbs = open ? [{ label: WINDOW_COPY['front-desk'].title, href: '/front-desk' }, { label: name }] : undefined;

  return (
    <AppPage
      app="front-desk"
      subtitle={<FrontDeskStatus />}
      actions={demo ? <SimulateCallButton /> : undefined}
      stats={showStats ? <KpiStrip /> : undefined}
      crumbs={crumbs}
      bare={phone && open}
      layout={phone ? 'flow' : 'fill'}
    >
      <div className={styles.split} data-detail={open ? 'open' : 'closed'}>
        {phone && open ? null : <InboxList conversationId={conversationId} />}
        {phone && !open ? null : (
          <div className={styles.detailPane}>
            {open ? <CallDetail key={conversationId} conversationId={conversationId} /> : <PickCall />}
          </div>
        )}
      </div>
    </AppPage>
  );
}
