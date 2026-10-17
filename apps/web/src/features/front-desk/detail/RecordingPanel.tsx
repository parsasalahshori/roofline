import { useEffect, useRef, useState } from 'react';
import type { CallView } from '@roofline/shared';
import { Button, Icon, Panel } from '@roofline/ui';
import { conversationCopy } from '../../../copy/front-desk-conversation.ts';
import { clock } from '../format.ts';
import styles from './RecordingPanel.module.css';

const copy = conversationCopy;
const BAR_COUNT = 110;
const RATES = [1, 1.5, 2] as const;

/** A small deterministic generator (mulberry32) seeded from a string, so a call always draws the same bars. */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Decorative bar heights (0.15 to 1) for a call without a decoded recording, the same every time for one id. */
function seededBars(seed: string, count: number): number[] {
  const next = seededRandom(seed);
  let previous = 0.5;
  return Array.from({ length: count }, () => {
    previous = previous * 0.45 + next() * 0.55;
    return 0.15 + previous * 0.85;
  });
}

/** Bar heights (0.15 to 1) from the loudest sample in each slice of the first audio channel. */
function peaksOf(samples: Float32Array, count: number): number[] {
  const size = Math.max(1, Math.floor(samples.length / count));
  const peaks = Array.from({ length: count }, (_, index) => {
    let peak = 0;
    const end = Math.min(samples.length, (index + 1) * size);
    for (let i = index * size; i < end; i += 1) peak = Math.max(peak, Math.abs(samples[i] ?? 0));
    return peak;
  });
  const loudest = Math.max(...peaks, 0);
  return peaks.map((peak) => (loudest === 0 ? 0.15 : 0.15 + (peak / loudest) * 0.85));
}

/** Bars drawn from the recording itself. Resolves to null when this browser cannot decode it. */
async function barsFromRecording(url: string, signal: AbortSignal): Promise<number[] | null> {
  const Context = typeof window === 'undefined' ? undefined : window.AudioContext;
  if (Context === undefined) return null;
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  const context = new Context();
  try {
    const decoded = await context.decodeAudioData(await response.arrayBuffer());
    return peaksOf(decoded.getChannelData(0), BAR_COUNT);
  } finally {
    void context.close();
  }
}

/** Seconds a call lasted: the assistant's own count, else start to end; null while it has neither. */
export function callSeconds(call: CallView): number | null {
  if (call.aiSeconds !== null) return call.aiSeconds;
  if (call.endedAt === null) return null;
  return Math.max(0, (Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000);
}

/** Whether this viewer can play the call's recording; without one the panel is left out. */
export function hasRecording(call: CallView): boolean {
  return call.canPlayRecording && call.recordingStatus === 'stored';
}

function PlayIcon({ paused }: { paused: boolean }) {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {paused ? <path d="M4 2.5v11l9-5.5z" /> : <path d="M3.5 2.5h3.5v11H3.5zM9 2.5h3.5v11H9z" />}
    </svg>
  );
}

/**
 * The call's recording: Listen, a waveform you can drag through, how far in and the speed. The audio streams from the
 * API's own route only after Listen is pressed, so a page of calls loads no sound. No storage address reaches the browser.
 */
export function RecordingPanel({ call }: { call: CallView }) {
  const source = `/api/calls/${call.id}/recording`;
  const audio = useRef<HTMLAudioElement>(null);
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(0);
  const [length, setLength] = useState(callSeconds(call) ?? 0);
  const [rate, setRate] = useState<(typeof RATES)[number]>(1);
  const [decoded, setDecoded] = useState<{ url: string; bars: number[] } | null>(null);

  // The bars are drawn from the recording once it was asked for; until then (or when it cannot be read) they are the seeded ones.
  useEffect(() => {
    if (!started) return;
    const controller = new AbortController();
    barsFromRecording(source, controller.signal)
      .then((bars) => {
        if (bars !== null) setDecoded({ url: source, bars });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [source, started]);

  const bars = decoded !== null && decoded.url === source ? decoded.bars : seededBars(call.id, BAR_COUNT);
  const progress = length > 0 ? Math.min(1, current / length) : 0;
  const filled = Math.round(progress * bars.length);
  const seekMax = Math.max(1, Math.round(length));

  const toggle = () => {
    setFailed(false);
    const element = audio.current;
    if (!started || element === null) {
      setStarted(true); // the element mounts with its source and autoplays
      return;
    }
    if (element.paused) void element.play().catch(() => setFailed(true));
    else element.pause();
  };

  const cycleRate = () => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1;
    setRate(next);
    if (audio.current) audio.current.playbackRate = next;
  };

  return (
    <Panel title={copy.recordingHeading} headingLevel={3} tag={length > 0 ? <span className={styles.mono}>{clock(length)}</span> : undefined}>
      <div className={styles.audio}>
        <Button variant="default" className={styles.listen} onClick={toggle}>
          <PlayIcon paused={!playing} />
          {playing ? copy.pause : copy.listen}
        </Button>
        <div className={styles.wave}>
          <div className={styles.bars} role="img" aria-label={copy.waveformLabel} data-testid="waveform">
            {bars.map((height, index) => (
              <span
                key={index}
                className={styles.bar}
                data-played={index < filled ? 'true' : undefined}
                style={{ height: `${Math.round(height * 100)}%` }}
              />
            ))}
          </div>
          <span className={styles.playhead} style={{ left: `${progress * 100}%` }} aria-hidden="true" />
          <input
            className={styles.seek}
            type="range"
            min={0}
            max={seekMax}
            step={1}
            value={Math.min(Math.round(current), seekMax)}
            aria-label={copy.seekLabel}
            disabled={!started || length <= 0}
            onChange={(event) => {
              const to = Number(event.currentTarget.value);
              if (audio.current) audio.current.currentTime = to;
              setCurrent(to);
            }}
          />
        </div>
        <span className={styles.time}>{copy.position(clock(current), clock(length))}</span>
        <Button variant="ghost" size="sm" className={styles.speed} aria-label={copy.speedLabel} onClick={cycleRate}>
          {copy.speed(rate)}
        </Button>
        {started ? (
          <audio
            ref={audio}
            className={styles.element}
            src={source}
            autoPlay
            preload="none"
            aria-label={copy.audioLabel}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              setCurrent(0);
            }}
            onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
            onLoadedMetadata={(event) => {
              const total = event.currentTarget.duration;
              if (Number.isFinite(total) && total > 0) setLength(total);
              event.currentTarget.playbackRate = rate;
            }}
            onError={() => {
              setStarted(false);
              setPlaying(false);
              setFailed(true);
            }}
          />
        ) : null}
      </div>
      {failed ? (
        <p className={styles.failed} role="alert">
          <Icon name="alert" size={16} />
          {copy.recordingFailed}
        </p>
      ) : null}
    </Panel>
  );
}
