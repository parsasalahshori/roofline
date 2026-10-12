import type { RelayIn, RelayOut, VoiceSession } from '../voice-session.ts';

/** The caller's end of the in-memory pair: it speaks into the session's handler. */
export class FakeVoiceCaller {
  constructor(private readonly session: FakeVoiceSession) {}

  setup(overrides: Partial<Extract<RelayIn, { type: 'setup' }>> = {}): void {
    this.session.deliver({
      type: 'setup',
      callSid: `CA${'a'.repeat(32)}`,
      from: '+15555550100',
      to: '+14025550100',
      customParameters: {},
      ...overrides,
    });
  }
  say(text: string): void {
    this.session.deliver({ type: 'prompt', voicePrompt: text, last: true });
  }
  interrupt(spoken: string): void {
    this.session.deliver({ type: 'interrupt', utteranceUntilInterrupt: spoken, durationUntilInterruptMs: 500 });
  }
  dtmf(digit: string): void {
    this.session.deliver({ type: 'dtmf', digit });
  }
  hangUp(): void {
    this.session.fireClose();
  }
  assistantText(): string {
    return this.session.assistantText();
  }
}

export class FakeVoiceSession implements VoiceSession {
  readonly sent: RelayOut[] = [];
  readonly caller = new FakeVoiceCaller(this);
  closed = false;
  endedWith: string | null = null;
  private messageHandlers: ((m: RelayIn) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private closeFired = false;

  onMessage(h: (m: RelayIn) => void): void {
    this.messageHandlers.push(h);
  }
  send(m: RelayOut): void {
    this.sent.push(m);
    if (m.type === 'end') this.endedWith = m.handoffData;
  }
  close(): void {
    this.closed = true;
    this.fireClose();
  }
  onClose(h: () => void): void {
    this.closeHandlers.push(h);
  }
  assistantText(): string {
    return this.sent.flatMap((m) => (m.type === 'text' ? [m.token] : [])).join('');
  }

  /** @internal used by the caller */
  deliver(m: RelayIn): void {
    for (const h of this.messageHandlers) h(m);
  }
  /** @internal fires the close handlers once */
  fireClose(): void {
    if (this.closeFired) return;
    this.closeFired = true;
    for (const h of this.closeHandlers) h();
  }
}
