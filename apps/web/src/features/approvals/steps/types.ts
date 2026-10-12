import type { ComponentType } from 'react';
import type { StepPreview, StepType } from '@roofline/shared';
import type { StepView } from '../../../api/types.ts';

/** What a step's Preview component takes. `canApprove` is the caller's right to approve this step (false for office on a spend step). */
export type StepPreviewProps = {
  step: StepView;
  canApprove: boolean;
  /** The plan the step belongs to. A Preview that saves a change itself (G1 Task 17p) needs it; Review always passes it. */
  taskId?: string;
};

/** Facts the Edit sheet knows that a kit's pure functions cannot look up. Passed as the last argument; absent in unit tests. */
export type StepKitContext = {
  /** The company's time zone (IANA name). */
  zone: string;
};

/**
 * One field of a step's Edit sheet. Values are held as strings (`pick` as a string[]) while typing:
 * `text`/`multiline` as is, `number` as typed digits, `lines` as one item per line, `pick` as the chosen option values.
 */
export type EditFieldSpec = {
  id: string;
  label: string;
  kind: 'text' | 'multiline' | 'number' | 'lines' | 'pick';
  value: string | string[];
  /** For `pick`: the choices. */
  options?: { value: string; label: string }[];
  help?: string;
};

export type EditValues = Record<string, string | string[]>;

/** A step type's review kit, registered by type in `steps/index.ts`. */
export type StepKit = {
  /** The detailed preview, drawn from the step's payload. */
  Preview: ComponentType<StepPreviewProps>;
  /** The preview data the kit's review list shows (title and lines); used by toReviewStep in place of the server's. */
  review(step: StepView): StepPreview;
  /** The fields the Edit sheet shows, filled from the step's current payload. */
  editFields(step: StepView, ctx?: StepKitContext): EditFieldSpec[];
  /** The step's whole payload with the edited values applied (unedited keys kept as they are). Must not throw. */
  toPayload(step: StepView, values: EditValues, ctx?: StepKitContext): Record<string, unknown>;
  /** A sentence under a field per field id for values that are allowed but worth a warning (missing tokens). Optional. */
  warnings?(step: StepView, values: EditValues): Record<string, string[]>;
  /** Field-id -> sentence for values that must not be saved (before the shared `validate` runs). Empty object when fine. */
  fieldErrors?(step: StepView, values: EditValues, ctx?: StepKitContext): Record<string, string>;
};

export type StepKits = Partial<Record<StepType, StepKit>>;
