import { useState } from 'react';
import { Banner, Button } from '@roofline/ui';
import type { CallView } from '@roofline/shared';
import { conversationCopy } from '../../copy/front-desk-conversation.ts';
import styles from './RecordingPlayer.module.css';

/**
 * A call's recording, for the roles allowed to hear it (spec §11). The audio element streams from the
 * API's own recording route and is rendered only after the person presses play, so a page full of
 * calls loads nothing. No storage URL ever reaches the browser.
 */
export function RecordingPlayer({ call }: { call: CallView }) {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!call.canPlayRecording) return null;

  const play = () => {
    setFailed(false);
    setPlaying(true);
  };

  return (
    <section className={styles.player} aria-label={conversationCopy.recordingHeading}>
      <h3 className={styles.heading}>{conversationCopy.recordingHeading}</h3>
      {playing ? (
        <audio
          className={styles.audio}
          controls
          autoPlay
          src={`/api/calls/${call.id}/recording`}
          onError={() => {
            setPlaying(false);
            setFailed(true);
          }}
          aria-label={conversationCopy.recordingLabel}
        />
      ) : (
        <Button variant="ghost" onClick={play}>
          {conversationCopy.playRecording}
        </Button>
      )}
      {failed ? <Banner tone="danger">{conversationCopy.recordingFailed}</Banner> : null}
    </section>
  );
}
