import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CallView } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingPlayer } from '../src/features/front-desk/RecordingPlayer.tsx';
import { conversationCopy } from '../src/copy/front-desk-conversation.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi> | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

const AT = '2026-10-11T14:00:00.000Z';
const call: CallView = {
  id: 'call1',
  status: 'ended',
  startedAt: AT,
  endedAt: AT,
  aiSeconds: 42,
  recordingStatus: 'stored',
  transcriptStored: true,
  transferResult: 'none',
  transferTo: null,
  spamReason: null,
  canPlayRecording: true,
};

describe('RecordingPlayer expired link', () => {
  it('returns to the play button when the audio errors', async () => {
    api = stubApi({
      'GET /api/calls/call1/recording': () => ({ body: { url: 'https://signed.example/rec.mp3', expiresAt: AT } }),
    });
    const queryClient = createQueryClient();
    const { container } = render(
      <Providers client={queryClient}>
        <RecordingPlayer call={call} />
      </Providers>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: conversationCopy.playRecording }));
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());

    fireEvent.error(container.querySelector('audio') as HTMLAudioElement);

    expect(await screen.findByRole('button', { name: conversationCopy.playRecording })).toBeInTheDocument();
    expect(container.querySelector('audio')).toBeNull();
  });
});
