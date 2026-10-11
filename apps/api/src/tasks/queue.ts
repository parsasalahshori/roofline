import type { AppDeps } from '../app.ts';
import { runStep } from './runner.ts';

/**
 * Where approved steps go to be run. The approval routes call `enqueueStep` only after their
 * transaction has committed, so a step is never run before it is saved as `queued`. Each enqueued
 * step is run with `runStep`; a run that throws is tried again later.
 */
export type StepQueue = {
  enqueueStep(companyId: string, stepId: string): Promise<void>;
};

export type QueuedStep = { companyId: string; stepId: string };

/**
 * The tests' queue: it records every `enqueueStep` call and runs nothing until `drain` is called.
 * `drain` then runs the waiting steps in the order they came, including any enqueued while it
 * drains. A run that throws goes to the back of the line and is run again, the way a real queue
 * retries a job. It stops with an error after `maxRuns` runs, so a step that never settles cannot
 * hang a test.
 */
export class InlineQueue implements StepQueue {
  /** Every `enqueueStep` call, in order. The re-runs `drain` makes after a throw are not calls. */
  readonly calls: QueuedStep[] = [];
  private readonly waiting: QueuedStep[] = [];

  async enqueueStep(companyId: string, stepId: string): Promise<void> {
    this.calls.push({ companyId, stepId });
    this.waiting.push({ companyId, stepId });
  }

  async drain(deps: AppDeps, maxRuns = 50): Promise<void> {
    let lastError: unknown;
    for (let runs = 0; this.waiting.length > 0; runs++) {
      if (runs >= maxRuns) {
        throw new Error(`InlineQueue.drain stopped after ${maxRuns} runs with ${this.waiting.length} still waiting.`, {
          cause: lastError,
        });
      }
      const job = this.waiting.shift()!;
      try {
        await runStep(deps, job.companyId, job.stepId);
      } catch (err) {
        lastError = err;
        this.waiting.push(job);
      }
    }
  }
}

/**
 * The server's queue until the pg-boss worker takes over: each step is run in this process, right
 * after the current request has been answered. A run that throws is logged and not tried again.
 */
export class ImmediateQueue implements StepQueue {
  constructor(
    private readonly deps: () => AppDeps,
    private readonly logError: (err: unknown, stepId: string) => void,
  ) {}

  async enqueueStep(companyId: string, stepId: string): Promise<void> {
    setImmediate(() => {
      void (async () => {
        try {
          await runStep(this.deps(), companyId, stepId);
        } catch (err) {
          try {
            this.logError(err, stepId);
          } catch {
            // A failing logger must not turn into an unhandled rejection.
          }
        }
      })();
    });
  }
}
