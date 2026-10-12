import { describe, expect, it } from 'vitest';
import { CONVERSATION_FILTERS, FRONT_DESK_LIMITS } from '../src/index.ts';

describe('Front Desk views', () => {
  it('lists the inbox filters from spec 13', () => {
    expect(CONVERSATION_FILTERS).toEqual(['all', 'needs_attention', 'booked', 'messages', 'spam']);
  });

  it('keeps the settings limits from spec 10', () => {
    expect(FRONT_DESK_LIMITS.factsMaxChars).toBe(2000);
    expect(FRONT_DESK_LIMITS.ringTeamFirstSeconds).toEqual({ min: 0, max: 30 });
    expect(FRONT_DESK_LIMITS.recordingRetentionDays).toEqual({ min: 0, max: 365 });
    expect(FRONT_DESK_LIMITS.transcriptRetentionDays).toEqual({ min: 30, max: 730 });
    expect(FRONT_DESK_LIMITS.maxConcurrentAiCalls).toEqual({ min: 1, max: 10 });
  });
});
