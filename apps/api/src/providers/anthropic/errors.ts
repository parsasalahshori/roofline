import Anthropic from '@anthropic-ai/sdk';
import { LlmUnavailableError } from '../llm.ts';

/**
 * Maps an SDK error (by class, never by message) to LlmUnavailableError. Aborts and non-API errors
 * are returned unchanged. The message carries only the HTTP status: no key, header or body text.
 */
export function toLlmError(err: unknown): unknown {
  if (err instanceof LlmUnavailableError) return err;
  if (err instanceof Anthropic.APIUserAbortError) {
    // The SDK's abort error is named 'Error'; callers (the engine's isAbort) look for 'AbortError'.
    return new DOMException('The request was aborted.', 'AbortError');
  }
  if ((err as { name?: string } | null)?.name === 'AbortError') return err;
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    return new LlmUnavailableError(`Claude request failed (${status ?? 'network'})`);
  }
  return err;
}

/** True when err is Anthropic.RateLimitError (HTTP 429). */
export function isRateLimit(err: unknown): boolean {
  return err instanceof Anthropic.RateLimitError;
}
