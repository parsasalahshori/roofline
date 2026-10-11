import type { StepView } from '../../api/types.ts';

/** The text of a step a person may rewrite, and the payload key it lives under; null when the step has none. */
export function editableText(step: StepView): { key: 'sample' | 'body'; value: string } | null {
  const sample = step.payload?.sample;
  if (step.type === 'demo_message' && typeof sample === 'string') return { key: 'sample', value: sample };
  const body = step.payload?.body;
  if (step.type === 'send_sms_batch' && typeof body === 'string') return { key: 'body', value: body };
  return null;
}
