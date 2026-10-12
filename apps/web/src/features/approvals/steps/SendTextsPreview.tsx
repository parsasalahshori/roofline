import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@roofline/ui';
import { apiFetch } from '../../../api/client.ts';
import type { StepView } from '../../../api/types.ts';
import { stepTexts } from '../../../copy/stepTexts.ts';
import styles from './SendTextsPreview.module.css';
import type { EditFieldSpec, EditValues, StepKit, StepPreviewProps } from './types.ts';

type Payload = Record<string, unknown>;
type Message = Record<string, unknown>;

const FIRST_ROWS = 20;
const MAX_LENGTH = 480;
const STOP_LINE = 'Reply STOP to opt out';

/** The step's payload as an object. A payload that is missing or not an object reads as empty. */
function payloadOf(step: StepView): Payload {
  const payload: unknown = step.payload;
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Payload) : {};
}

/** The messages that are objects, in order. */
function messagesOf(step: StepView): Message[] | null {
  const raw = payloadOf(step).messages;
  if (!Array.isArray(raw)) return null;
  return raw.filter((m): m is Message => m !== null && typeof m === 'object' && !Array.isArray(m));
}

function bodyOf(message: Message): string {
  return typeof message.body === 'string' ? message.body : '';
}

/** Which texts of a review message do not end with the opt-out line. Other kinds have none. */
export function missingStopIndexes(payloadKind: unknown, bodies: string[]): number[] {
  if (payloadKind !== 'review') return [];
  const out: number[] = [];
  bodies.forEach((body, i) => {
    const trimmed = body.trim();
    const stripped = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
    if (!stripped.endsWith(STOP_LINE)) out.push(i);
  });
  return out;
}

/** The customer's name for a row: first name, else the display name, else "Customer N" while it loads or if it is gone. */
function RecipientName({ customerId, place }: { customerId: string; place: number }) {
  const customer = useQuery({
    queryKey: ['customers', 'one', customerId],
    queryFn: ({ signal }) =>
      apiFetch<{ firstName: string | null; displayName: string }>(`/api/customers/${encodeURIComponent(customerId)}`, { signal }),
    enabled: customerId !== '',
    staleTime: 60_000,
  });
  const name = customer.data?.displayName || customer.data?.firstName || stepTexts.customerN(place);
  return <p className={styles.label}>{name}</p>;
}

function customerIdOf(message: Message): string {
  return typeof message.customerId === 'string' ? message.customerId : '';
}

/** The personal texts under a send_personal_texts step: one row per text, each removable while the plan can change. */
export function SendTextsPreview({ step, onSavePayload }: StepPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const payload = payloadOf(step);
  const messages = messagesOf(step) ?? [];
  const missing = new Set(missingStopIndexes(payload.kind, messages.map(bodyOf)));
  const shown = expanded ? messages : messages.slice(0, FIRST_ROWS);
  const canRemove = onSavePayload !== undefined && messages.length > 1;

  function remove(index: number) {
    onSavePayload?.({ ...payload, messages: messages.filter((_, i) => i !== index) });
  }

  return (
    <div className={styles.preview}>
      {shown.map((message, i) => (
        <div key={`${customerIdOf(message)}:${i}`} className={styles.row}>
          <div className={styles.text}>
            <RecipientName customerId={customerIdOf(message)} place={i + 1} />
            <p className={styles.body}>{bodyOf(message)}</p>
            {missing.has(i) ? <p className={styles.warning}>{stepTexts.missingStop}</p> : null}
          </div>
          {canRemove ? (
            <Button
              variant="ghost"
              onClick={() => {
                remove(i);
              }}
            >
              {stepTexts.remove}
            </Button>
          ) : null}
        </div>
      ))}
      {!expanded && messages.length > FIRST_ROWS ? (
        <Button
          onClick={() => {
            setExpanded(true);
          }}
        >
          {stepTexts.showMore(messages.length - FIRST_ROWS)}
        </Button>
      ) : null}
      {onSavePayload !== undefined && messages.length === 1 ? <p className={styles.hint}>{stepTexts.lastOne}</p> : null}
    </div>
  );
}

function editFields(step: StepView): EditFieldSpec[] {
  return (messagesOf(step) ?? []).map((message, i) => ({
    id: `m${i}`,
    label: stepTexts.textTo(i + 1),
    kind: 'multiline',
    value: bodyOf(message),
  }));
}

function toPayload(step: StepView, values: EditValues): Record<string, unknown> {
  const payload = payloadOf(step);
  const messages = messagesOf(step);
  if (messages === null) return { ...payload };
  return {
    ...payload,
    messages: messages.map((message, i) => {
      const edited = values[`m${i}`];
      return edited === undefined ? message : { ...message, body: String(edited) };
    }),
  };
}

function fieldErrors(step: StepView, values: EditValues): Record<string, string> {
  const out: Record<string, string> = {};
  (messagesOf(step) ?? []).forEach((_, i) => {
    const value = values[`m${i}`];
    if (value === undefined) return;
    const text = String(value);
    if (text.trim() === '') out[`m${i}`] = stepTexts.empty;
    else if (text.length > MAX_LENGTH) out[`m${i}`] = stepTexts.tooLong;
  });
  return out;
}

function warnings(step: StepView, values: EditValues): Record<string, string[]> {
  const messages = messagesOf(step) ?? [];
  const bodies = messages.map((message, i) => String(values[`m${i}`] ?? bodyOf(message)));
  const out: Record<string, string[]> = {};
  for (const i of missingStopIndexes(payloadOf(step).kind, bodies)) out[`m${i}`] = [stepTexts.missingStop];
  return out;
}

export const sendTextsKit: StepKit = {
  Preview: SendTextsPreview,
  review: (step) => {
    const messages = messagesOf(step);
    if (messages === null) return { ...step.preview };
    const bodies = messages.map(bodyOf);
    return {
      ...step.preview,
      title: stepTexts.title(messages.length),
      lines: bodies.slice(0, 3),
      recipientCount: messages.length,
      ...(bodies[0] !== undefined && { messageSample: bodies[0] }),
    };
  },
  editFields,
  toPayload,
  fieldErrors,
  warnings,
};
