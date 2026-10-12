import { useState } from 'react';
import { Banner, Button } from '@roofline/ui';
import type { CallView } from '@roofline/shared';
import { conversationCopy } from '../../copy/front-desk-conversation.ts';
import { useRecordingLink } from './conversation-api.ts';
import styles from './RecordingPlayer.module.css';

/**
 * A call's recording, for the roles allowed to hear it (spec §11). The signed URL is fetched only
 * when the person presses play, never on mount, so a page full of calls makes no requests.
 */
export function RecordingPlayer({ call }: { call: CallView }) {
  const link = useRecordingLink();
  const [url, setUrl] = useState<string | null>(null);

  if (!call.canPlayRecording) return null;

  const play = async () => {
    try {
      const result = await link.mutateAsync(call.id);
      setUrl(result.url);
    } catch {
      // The failure shows through link.isError below; nothing else to do here.
    }
  };

  return (
    <section className={styles.player} aria-label={conversationCopy.recordingHeading}>
      <h3 className={styles.heading}>{conversationCopy.recordingHeading}</h3>
      {url === null ? (
        <Button variant="ghost" busy={link.isPending} onClick={play}>
          {conversationCopy.playRecording}
        </Button>
      ) : (
        <audio className={styles.audio} controls autoPlay src={url} onError={() => setUrl(null)} aria-label={conversationCopy.recordingLabel} />
      )}
      {link.isPending ? <p className={styles.status}>{conversationCopy.recordingLoading}</p> : null}
      {link.isError ? <Banner tone="danger">{conversationCopy.recordingFailed}</Banner> : null}
    </section>
  );
}
