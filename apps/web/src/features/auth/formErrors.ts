import { ApiError } from '../../api/client.ts';
import { errors } from '../../copy/errors.ts';

export type FormErrors = {
  /** The message the server gave for this field, if it named it. */
  forField: (field: string) => string | undefined;
  /** Everything else that went wrong, for the top of the form. */
  general: string | undefined;
  /** The error itself, when it came from the server. */
  api: ApiError | null;
};

/**
 * Splits a failed request into what belongs next to a field and what belongs to the whole form.
 * `fields` are the fields this form shows; a message about any other field has nowhere to sit
 * next to, so it is general.
 */
export function formErrors(error: Error | null, fields: readonly string[]): FormErrors {
  const api = error instanceof ApiError ? error : null;
  const onForm = api?.field !== undefined && fields.includes(api.field);
  return {
    forField: (field) => (api?.field === field && onForm ? api.message : undefined),
    // Anything that is not an ApiError is our mistake, not something to show a person word for word
    general: error === null || onForm ? undefined : (api?.message ?? errors.generic),
    api,
  };
}
