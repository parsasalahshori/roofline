import type { AppDeps } from './app.ts';
import type { MailMessage } from './mailer.ts';

/**
 * Work the app starts after it has already answered, and the emails sent that way. One instance per
 * router; they all report to `deps.onBackgroundTask`, which is how tests wait for the work.
 */
export function createBackground(deps: AppDeps, logError: (err: unknown, path: string) => void) {
  /**
   * Runs `work` after the request has been answered: the caller does not await it. A failure is
   * logged and goes no further (it would otherwise be an unhandled rejection, which ends the
   * process). `deps.onBackgroundTask` lets tests wait for it.
   */
  function background(path: string, work: () => Promise<void>): void {
    const task = (async () => {
      try {
        await work();
      } catch (err) {
        try {
          logError(err, path);
        } catch {
          // A failing logger must not turn into an unhandled rejection.
        }
      }
    })();
    deps.onBackgroundTask?.(task);
  }

  /**
   * Hands an email to the mailer in the background. A failure is logged and never shown: the
   * account (or the invite, or the "if that address has an account" answer) does not depend on the
   * mail provider being up, and the person can ask for another.
   */
  function queueMail(msg: MailMessage, path: string): void {
    background(path, () => deps.mailer.send(msg));
  }

  return { background, queueMail };
}
