import { useToast } from '@roofline/ui';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client.ts';
import type { StepView, TaskView } from '../../api/types.ts';
import { approvals } from '../../copy/approvals.ts';
import { errors } from '../../copy/errors.ts';
import { review } from '../../copy/review.ts';
import { useDecline, useEditStep } from './api.ts';
import { editableText } from './editable.ts';
import { EditStepSheet } from './EditStepSheet.tsx';
import { NotNowSheet } from './NotNowSheet.tsx';
import { StepFieldsSheet } from './StepFieldsSheet.tsx';
import { kitFor } from './steps/index.ts';

/** The sentence an error carries: the server's own words for a refusal, the general line for anything else. */
export function errorSentence(error: Error): string {
  return error instanceof ApiError ? error.message : errors.generic;
}

/**
 * "Not now" with its sheet: an optional reason, then the plan is set aside. A 400 keeps the sheet open with the server's
 * sentence on the field; a 409 closes it (the plan changed, and the answer says so). `onDeclined` runs after the toast;
 * `onError` gets the failure of any other kind, to be shown next to the plan.
 */
export function useNotNowSheet(taskId: string, handlers: { onDeclined?: (task: TaskView) => void; onError: (error: Error) => void }) {
  const toast = useToast();
  const decline = useDecline(taskId);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  function close() {
    setOpen(false);
    setError(undefined);
  }

  function confirm(reason: string) {
    if (decline.isPending) return;
    decline.mutate(
      { reason },
      {
        onSuccess: (task) => {
          setOpen(false);
          toast.show(approvals.declined, 'success');
          handlers.onDeclined?.(task);
        },
        onError: (failure) => {
          if (failure instanceof ApiError && failure.status === 400) {
            setError(failure.message);
            return;
          }
          if (failure instanceof ApiError && failure.status === 409) setOpen(false);
          handlers.onError(failure);
        },
      },
    );
  }

  const sheet: ReactNode = open ? <NotNowSheet saving={decline.isPending} error={error} onConfirm={confirm} onClose={close} /> : null;
  return {
    sheet,
    open: () => {
      setError(undefined);
      setOpen(true);
    },
    pending: decline.isPending,
  };
}

/** Whether a step has something a person may edit: a text, or the fields its review kit lists. */
export function isEditable(step: StepView): boolean {
  return editableText(step) !== null || (kitFor(step)?.editFields(step).length ?? 0) > 0;
}

/**
 * The Edit sheet of a step: the generic fields sheet for a step with a review kit, the one-field text sheet for a
 * plain message. `lookup` finds the step as it is now (the review screen keeps asking the server), so a save carries
 * the version the screen last saw. A 400 keeps the sheet open with the sentence on the field; a 409 closes it.
 */
export function useStepSheet(
  taskId: string,
  lookup: (stepId: string) => StepView | undefined,
  handlers: { onError: (error: Error) => void; onSaved?: () => void },
) {
  const edit = useEditStep(taskId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const step = editingId === null ? undefined : lookup(editingId);
  const text = step === undefined ? null : editableText(step);
  // A step type with a review kit is edited through the generic sheet (fields from the kit)
  const kit = step === undefined ? undefined : kitFor(step);

  function close() {
    setEditingId(null);
    setError(undefined);
  }

  /** Sends the step's new payload. A 400 keeps the sheet open with the server's sentence; a 409 closes it. */
  function send(target: StepView, payload: Record<string, unknown>) {
    void edit
      .mutateAsync({ stepId: target.id, version: target.version, payload })
      .then(() => {
        close();
        handlers.onSaved?.();
      })
      .catch((failure: Error) => {
        if (failure instanceof ApiError && failure.status === 400) {
          // The sentence belongs on the field, and the sheet stays open so the text can be fixed
          setError(failure.message);
          return;
        }
        if (failure instanceof ApiError && failure.status === 409) close();
        handlers.onError(failure);
      });
  }

  let sheet: ReactNode = null;
  if (step !== undefined && kit !== undefined) {
    sheet = (
      <StepFieldsSheet
        key={step.id}
        step={step}
        kit={kit}
        saving={edit.isPending}
        error={error}
        onSave={(payload) => send(step, payload)}
        onClose={close}
      />
    );
  } else if (step !== undefined && text !== null) {
    sheet = (
      <EditStepSheet
        key={step.id}
        fieldLabel={review.messageLabel}
        initialText={text.value}
        saving={edit.isPending}
        error={error}
        onSave={(value) => send(step, { ...(step.payload ?? {}), [text.key]: value })}
        onClose={close}
      />
    );
  }

  return {
    sheet,
    open: (stepId: string) => {
      setEditingId(stepId);
      setError(undefined);
    },
  };
}
