import { EmptyState } from '@roofline/ui';
import { frontDesk } from '../../copy/front-desk.ts';

export function ConversationWindow() {
  return <EmptyState title={frontDesk.conversationEmpty} />;
}
