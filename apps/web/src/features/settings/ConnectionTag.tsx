import { Tag, type IconName, type TagTone } from '@roofline/ui';
import { connections } from '../../copy/connections.ts';

/** How a connection stands: working, waiting for the person, broken, or not set up. */
export type ConnectionState = 'connected' | 'waiting' | 'attention' | 'off';

const LOOKS: Record<ConnectionState, { tone: TagTone; icon: IconName; word: string }> = {
  connected: { tone: 'ok', icon: 'check', word: connections.statuses.active },
  waiting: { tone: 'warn', icon: 'clock', word: connections.statuses.pending },
  attention: { tone: 'bad', icon: 'alert', word: connections.statuses.error },
  off: { tone: 'neutral', icon: 'minus', word: connections.notConnected },
};

/** The tag at the right of a connection card's title: its state as an icon and a word, never a colour alone. */
export function ConnectionTag({ state }: { state: ConnectionState }) {
  const look = LOOKS[state];
  return (
    <Tag tone={look.tone} icon={look.icon}>
      {look.word}
    </Tag>
  );
}
