import { useParams } from 'react-router';
import { useMarkReadOnOpen } from './conversation-api.ts';
import { CallDetail } from './lift/CallDetail.tsx';

/** One conversation on its own (the detail without the list beside it). The window route shows it beside the list. */
export function ConversationWindow() {
  const { conversationId = '' } = useParams();
  useMarkReadOnOpen(conversationId);
  return <CallDetail conversationId={conversationId} />;
}
