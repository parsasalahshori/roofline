import type { ConversationState } from './engine-types.ts';

/** A summary of the call state the router sees. */
export type EngineStateSummary = {
  verified: boolean;
  turns: number;
  identity: string;
  channel: string;
  taskInProgress: boolean;
  failedUnderstanding: number;
  [key: string]: unknown;
};

export function summarize(state: ConversationState): EngineStateSummary {
  return {
    verified: state.identity === 'verified',
    turns: state.turns,
    identity: state.identity,
    channel: state.channel,
    taskInProgress: state.taskInProgress,
    failedUnderstanding: state.failedUnderstanding,
  };
}
