import type { ToolHandler } from '../engine-types.ts';

/* D1 Task 9: end_call. No writes: the engine turns it into an end event and marks spam. */

export const endCall: ToolHandler<'end_call'> = async (_ctx, input) => ({
  ok: true,
  forModel: 'Say a short goodbye.',
  action: 'end_' + input.reason,
});
