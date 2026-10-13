import { useEffect, useRef, useState } from 'react';
import type { CallView, ConversationDetail, TurnView } from '@roofline/shared';
import { Avatar, Button, EmptyState, Skeleton } from '@roofline/ui';
import { frontDeskInbox } from '../../../copy/front-desk-inbox.ts';
import { liftCall } from '../../../copy/liftCall.ts';
import { formatPhone } from '../../../lib/phone.ts';
import { useConversation } from '../conversation-api.ts';
import styles from './CallDetail.module.css';

const BAR_COUNT = 64;
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

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** "Today at 12:20 PM", "Yesterday at ...", or "Oct 9 at ..." in the browser's time zone. */
function whenLabel(iso: string, now: Date): string {
  const at = new Date(iso);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(at);
  if (days === 0) return liftCall.today(time);
  if (days === 1) return liftCall.yesterday(time);
  return liftCall.onDate(new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(at), time);
}

/** Seconds a call lasted: the assistant's own count, else start to end; null while it has neither. */
function callSeconds(call: CallView): number | null {
  if (call.aiSeconds !== null) return call.aiSeconds;
  if (call.endedAt === null) return null;
  return Math.max(0, (Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000);
}

function turnNote(turn: TurnView, call: CallView | undefined): string {
  if (turn.noWords === true) return liftCall.noWords;
  return call !== undefined && !call.transcriptStored ? liftCall.transcriptNotKept : liftCall.transcriptRemoved;
}

function PlayIcon({ paused }: { paused: boolean }) {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {paused ? <path d="M4 2.5v11l9-5.5z" /> : <path d="M3.5 2.5h3.5v11H3.5zM9 2.5h3.5v11H9z" />}
    </svg>
  );
}

function AssistantMark() {
  return (
    <span className={styles.mark} aria-hidden="true">
      <svg viewBox="0 0 16 16" focusable="false">
        <path d="M8 1.5l1.6 4.4 4.4 1.6-4.4 1.6L8 13.5 6.4 9.1 2 7.5l4.4-1.6z" />
      </svg>
    </span>
  );
}

/** The audio row: Listen, the bars, the time and the speed. Disabled, with the reason, when there is no recording. */
function AudioRow({ call, seedId }: { call: CallView | null; seedId: string }) {
  const playable = call !== null && call.canPlayRecording && call.recordingStatus === 'stored';
  const source = playable ? `/api/calls/${call.id}/recording` : null;
  const audio = useRef<HTMLAudioElement>(null);
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(0);
  const [length, setLength] = useState(call === null ? 0 : (callSeconds(call) ?? 0));
  const [rate, setRate] = useState<(typeof RATES)[number]>(1);
  const [decoded, setDecoded] = useState<{ url: string; bars: number[] } | null>(null);

  // The bars are drawn from the recording once it was asked for; until then (or when it cannot be read) they are the seeded ones.
  useEffect(() => {
    if (source === null || !started) return;
    const controller = new AbortController();
    barsFromRecording(source, controller.signal)
      .then((bars) => {
        if (bars !== null) setDecoded({ url: source, bars });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [source, started]);

  const bars = decoded !== null && decoded.url === source ? decoded.bars : seededBars(seedId, BAR_COUNT);
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
    <div className={styles.audio} data-disabled={playable ? undefined : 'true'}>
      <Button className={styles.listen} size="md" disabled={!playable} onClick={toggle}>
        <PlayIcon paused={!playing} />
        {playing ? liftCall.pause : liftCall.listen}
      </Button>
      <div className={styles.wave}>
        <div className={styles.bars} role="img" aria-label={liftCall.waveformLabel} data-testid="waveform">
          {bars.map((height, index) => (
            <span
              key={index}
              className={styles.bar}
              data-played={index < filled ? 'true' : undefined}
              style={{ height: `${Math.round(height * 100)}%` }}
            />
          ))}
        </div>
        {playable ? (
          <input
            className={styles.seek}
            type="range"
            min={0}
            max={seekMax}
            step={1}
            value={Math.min(Math.round(current), seekMax)}
            aria-label={liftCall.seekLabel}
            disabled={!started || length <= 0}
            onChange={(event) => {
              const to = Number(event.currentTarget.value);
              if (audio.current) audio.current.currentTime = to;
              setCurrent(to);
            }}
          />
        ) : null}
      </div>
      {playable ? (
        <>
          <span className={styles.time}>{liftCall.position(clock(current), clock(length))}</span>
          <Button variant="ghost" size="md" className={styles.speed} aria-label={liftCall.speedLabel} onClick={cycleRate}>
            {liftCall.speed(rate)}
          </Button>
        </>
      ) : (
        <span className={styles.time}>{liftCall.noRecording}</span>
      )}
      {started && source !== null ? (
        <audio
          ref={audio}
          className={styles.element}
          src={source}
          autoPlay
          preload="none"
          aria-label={liftCall.audioLabel}
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
      {failed ? (
        <p className={styles.failed} role="alert">
          {liftCall.recordingFailed}
        </p>
      ) : null}
    </div>
  );
}

function Bubble({ turn, call }: { turn: TurnView; call: CallView | undefined }) {
  if (turn.speaker === 'system') {
    return (
      <li className={styles.system} data-speaker="system">
        {turn.text ?? turnNote(turn, call)}
      </li>
    );
  }
  const mine = turn.speaker !== 'caller';
  return (
    <li className={styles.turn} data-speaker={turn.speaker} data-side={mine ? 'right' : 'left'}>
      {mine ? null : <span className={styles.caller} aria-hidden="true" />}
      <div className={styles.bubble}>
        <span className={styles.speaker}>{liftCall.speaker[turn.speaker]}</span>
        {turn.text !== null ? <p className={styles.text}>{turn.text}</p> : <p className={styles.note}>{turnNote(turn, call)}</p>}
        {turn.truncated ? <span className={styles.chip}>{liftCall.truncated}</span> : null}
        {turn.actions.map((card, index) => (
          <span key={`${turn.id}-${index}`} className={styles.chip} data-ok={card.ok ? 'true' : 'false'}>
            {liftCall.actionChip(card.label, card.ok)}
          </span>
        ))}
      </div>
      {mine ? <AssistantMark /> : null}
    </li>
  );
}

function Detail({ conversation }: { conversation: ConversationDetail }) {
  const name = conversation.customer?.name ?? null;
  const isCall = conversation.channel === 'voice';
  const lastCall = conversation.calls.at(-1) ?? null;
  const jobId = conversation.links.jobIds[0] ?? null;
  const turns = [...conversation.turns].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.position - b.position);
  const started = lastCall?.startedAt ?? turns[0]?.at ?? null;
  const seconds = lastCall === null ? null : callSeconds(lastCall);

  return (
    <article className={styles.detail}>
      <header className={styles.header}>
        <Avatar name={name ?? liftCall.unknownCaller} size={40} />
        <div className={styles.who}>
          <div className={styles.nameRow}>
            <h2 className={styles.name}>{name ?? liftCall.unknownCaller}</h2>
            {conversation.outcome !== null ? (
              <span className={styles.outcome}>{frontDeskInbox.outcomes[conversation.outcome]}</span>
            ) : null}
          </div>
          <p className={styles.meta}>
            <span>{formatPhone(conversation.phoneE164)}</span>
            {started !== null ? (
              <>
                <span aria-hidden="true"> · </span>
                <span>{whenLabel(started, new Date())}</span>
              </>
            ) : null}
            {seconds !== null ? (
              <>
                <span aria-hidden="true"> · </span>
                <span>{liftCall.duration(clock(seconds), isCall ? liftCall.callWord : liftCall.textWord)}</span>
              </>
            ) : null}
          </p>
        </div>
        {jobId !== null ? (
          <Button className={styles.openJob} size="md" href={`/jobs/${jobId}`}>
            {liftCall.openJob}
          </Button>
        ) : null}
      </header>

      {conversation.summary ? (
        <section className={styles.summary} aria-labelledby={`summary-${conversation.id}`}>
          <h3 id={`summary-${conversation.id}`} className={styles.summaryHeading}>
            {liftCall.summaryHeading}
          </h3>
          <p className={styles.summaryText}>{conversation.summary}</p>
        </section>
      ) : null}

      {isCall ? <AudioRow key={lastCall?.id ?? conversation.id} call={lastCall} seedId={lastCall?.id ?? conversation.id} /> : null}

      <section className={styles.transcript} aria-labelledby={`transcript-${conversation.id}`}>
        <div className={styles.transcriptHead}>
          <h3 id={`transcript-${conversation.id}`} className={styles.transcriptHeading}>
            {liftCall.transcriptHeading}
          </h3>
          <span className={styles.count}>{liftCall.messageCount(turns.length)}</span>
        </div>
        {turns.length === 0 ? (
          <p className={styles.empty}>{liftCall.transcriptEmpty}</p>
        ) : (
          <ol className={styles.turns}>
            {turns.map((turn) => (
              <Bubble key={turn.id} turn={turn} call={conversation.calls.find((c) => c.id === turn.callId)} />
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}

/** The right side of the Front Desk window: who called, what the assistant did, the recording and what was said. */
export function CallDetail({ conversationId }: { conversationId: string }) {
  const conversation = useConversation(conversationId);

  if (conversation.isPending) {
    return (
      <div className={styles.detail} role="status" aria-label={liftCall.loading}>
        <Skeleton lines={4} height="16px" />
      </div>
    );
  }
  if (conversation.isError || !conversation.data) return <EmptyState title={liftCall.loadFailed} />;
  return <Detail conversation={conversation.data} />;
}
