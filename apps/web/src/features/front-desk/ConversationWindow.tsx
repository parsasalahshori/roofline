import { useParams } from 'react-router';
import { CallDetail } from './lift/CallDetail.tsx';

/** One conversation on its own (the detail without the list beside it). The window route shows it beside the list. */
export function ConversationWindow() {
  const { conversationId = '' } = useParams();
  return <CallDetail conversationId={conversationId} />;
}
