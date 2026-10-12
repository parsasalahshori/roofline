// The ConversationRelay protocol, typed (D1 Task 4).
export type RelayIn = { type: 'setup'; callSid: string; from: string; to: string; customParameters: Record<string, string> } | { type: 'prompt'; voicePrompt: string; last: boolean }
  | { type: 'interrupt'; utteranceUntilInterrupt: string; durationUntilInterruptMs: number } | { type: 'dtmf'; digit: string } | { type: 'error'; description: string };
export type RelayOut = { type: 'text'; token: string; last: boolean; interruptible?: boolean } | { type: 'end'; handoffData: string } | { type: 'play'; source: string };
export interface VoiceSession { onMessage(h: (m: RelayIn) => void): void; send(m: RelayOut): void; close(): void; onClose(h: () => void): void }
