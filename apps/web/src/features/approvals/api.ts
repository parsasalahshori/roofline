import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError, apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import type { ApprovalsList, StepView, TaskView } from '../../api/types.ts';
import { countedDrafts } from '../../shell/countedDrafts.ts';
import { pollInterval } from './polling.ts';

/*
 * The data hooks of one plan, and of the review screen that shows it. The approvals list reads
 * `useApprovals` (api/hooks.ts), which the shell already shares.
 */

/** A step's switch, text or both, as the server takes them. `version` is the one the screen last saw. */
export type EditStepVariables = {
  stepId: string;
  version: number;
  enabled?: boolean;
  payload?: Record<string, unknown>;
};

/** Whether a value has the shape of a plan: an id and its steps. A 409 carries one when the plan changed. */
function isTaskView(value: unknown): value is TaskView {
  if (typeof value !== 'object' || value === null) return false;
  const { id, steps } = value as { id?: unknown; steps?: unknown };
  return typeof id === 'string' && Array.isArray(steps);
}

/**
 * A 409 means the screen was out of date. The server sends the current state with it: a plan (put
 * straight into the cache, not refetched, which would undo it) or a single step (the plan is asked
 * for again). The list is asked for again either way. Anything other than a 409 is left alone.
 */
export function reconcileConflict(queryClient: QueryClient, taskId: string, error: unknown): void {
  if (!(error instanceof ApiError) || error.status !== 409) return;
  if (isTaskView(error.latest)) {
    queryClient.setQueryData<TaskView>(keys.task(taskId), error.latest);
  } else {
    void queryClient.invalidateQueries({ queryKey: keys.task(taskId) });
  }
  void queryClient.invalidateQueries({ queryKey: keys.approvals });
}

/**
 * One plan with its steps. While `pollUntil` is in the future, or while a step is queued or
 * running, it is asked for again every 2 seconds (`pollInterval` decides).
 */
export function useTask(taskId: string, pollUntil = 0) {
  const id = encodeURIComponent(taskId);
  return useQuery({
    queryKey: keys.task(taskId),
    queryFn: ({ signal }) => apiFetch<TaskView>(`/api/approvals/${id}`, { signal }),
    refetchInterval: (query) => pollInterval(query.state.data, pollUntil, Date.now()),
  });
}

/**
 * Switches a step on or off, or saves its payload. A switch is shown at once (optimistic); the
 * server's answer for the step replaces the one in the plan.
 */
export function useEditStep(taskId: string) {
  const queryClient = useQueryClient();
  const id = encodeURIComponent(taskId);
  return useMutation<StepView, Error, EditStepVariables, { previous: TaskView | undefined }>({
    mutationFn: ({ stepId, version, enabled, payload }) =>
      apiFetch<StepView>(`/api/approvals/${id}/steps/${encodeURIComponent(stepId)}`, {
        method: 'PATCH',
        body: {
          version,
          ...(enabled !== undefined && { enabled }),
          ...(payload !== undefined && { payload }),
        },
      }),
    onMutate: async ({ stepId, enabled }) => {
      await queryClient.cancelQueries({ queryKey: keys.task(taskId) });
      const previous = queryClient.getQueryData<TaskView>(keys.task(taskId));
      if (enabled !== undefined && previous !== undefined) {
        queryClient.setQueryData<TaskView>(keys.task(taskId), {
          ...previous,
          steps: previous.steps.map((step) => (step.id === stepId ? { ...step, enabled } : step)),
        });
      }
      return { previous };
    },
    onError: (error, variables, context) => {
      // Only this step's switch goes back. Restoring the whole snapshot would also undo a neighbouring
      // step that has answered since, or a switch that is still on its way
      const before =
        variables.enabled === undefined ? undefined : context?.previous?.steps.find((step) => step.id === variables.stepId);
      if (before !== undefined) {
        queryClient.setQueryData<TaskView>(keys.task(taskId), (current) =>
          current === undefined
            ? current
            : {
                ...current,
                steps: current.steps.map((step) => (step.id === before.id ? { ...step, enabled: before.enabled } : step)),
              },
        );
      }
      reconcileConflict(queryClient, taskId, error);
    },
    onSuccess: (step) => {
      queryClient.setQueryData<TaskView>(keys.task(taskId), (current) =>
        current === undefined
          ? current
          : { ...current, steps: current.steps.map((existing) => (existing.id === step.id ? step : existing)) },
      );
    },
  });
}

/** Approves the steps the screen showed, each at the version it showed. The answer is the plan as it is now. */
export function useApprove(taskId: string) {
  const queryClient = useQueryClient();
  const id = encodeURIComponent(taskId);
  return useMutation<TaskView, Error, { steps: { id: string; version: number }[] }>({
    mutationFn: ({ steps }) => apiFetch<TaskView>(`/api/approvals/${id}/approve`, { method: 'POST', body: { steps } }),
    onSuccess: (task) => {
      queryClient.setQueryData<TaskView>(keys.task(taskId), task);
      void queryClient.invalidateQueries({ queryKey: keys.approvals });
      void queryClient.invalidateQueries({ queryKey: keys.summary });
    },
    onError: (error) => {
      reconcileConflict(queryClient, taskId, error);
    },
  });
}

/** Sets the whole plan aside. A blank reason is not sent at all. */
export function useDecline(taskId: string) {
  const queryClient = useQueryClient();
  const id = encodeURIComponent(taskId);
  return useMutation<TaskView, Error, { reason: string }>({
    mutationFn: ({ reason }) => {
      const trimmed = reason.trim();
      return apiFetch<TaskView>(`/api/approvals/${id}/decline`, {
        method: 'POST',
        body: trimmed === '' ? {} : { reason: trimmed },
      });
    },
    onSuccess: (task) => {
      queryClient.setQueryData<TaskView>(keys.task(taskId), task);
      void queryClient.invalidateQueries({ queryKey: keys.approvals });
      void queryClient.invalidateQueries({ queryKey: keys.summary });
    },
    onError: (error) => {
      reconcileConflict(queryClient, taskId, error);
    },
  });
}

/** Tries a step that did not finish once more. */
export function useRetryStep(taskId: string) {
  const queryClient = useQueryClient();
  const id = encodeURIComponent(taskId);
  return useMutation<TaskView, Error, { stepId: string }>({
    mutationFn: ({ stepId }) =>
      apiFetch<TaskView>(`/api/approvals/${id}/steps/${encodeURIComponent(stepId)}/retry`, { method: 'POST' }),
    onSuccess: (task) => {
      queryClient.setQueryData<TaskView>(keys.task(taskId), task);
      void queryClient.invalidateQueries({ queryKey: keys.summary });
    },
    onError: (error) => {
      reconcileConflict(queryClient, taskId, error);
    },
  });
}

/** Runs an expired plan again. The server answers with the new plan, which is put in the cache under its own id. */
export function useRerun(taskId: string) {
  const queryClient = useQueryClient();
  const id = encodeURIComponent(taskId);
  return useMutation<TaskView, Error, void>({
    mutationFn: () => apiFetch<TaskView>(`/api/approvals/${id}/rerun`, { method: 'POST' }),
    onSuccess: (next) => {
      queryClient.setQueryData<TaskView>(keys.task(next.id), next);
      void queryClient.invalidateQueries({ queryKey: keys.approvals });
    },
    onError: (error) => {
      reconcileConflict(queryClient, taskId, error);
    },
  });
}

/**
 * Where to go after a plan was set aside: back to the list when other plans still wait for a yes,
 * else to the map. The list is asked for fresh, so the answer is not the one from before the decline.
 */
export async function pathAfterDecline(queryClient: QueryClient, declinedTaskId: string): Promise<'/approvals' | '/'> {
  const list = await queryClient
    .fetchQuery({
      queryKey: keys.approvals,
      queryFn: ({ signal }) => apiFetch<ApprovalsList>('/api/approvals', { signal }),
      staleTime: 0,
    })
    .catch(() => undefined);
  const remaining = countedDrafts(list).filter((task) => task.id !== declinedTaskId);
  return remaining.length > 0 ? '/approvals' : '/';
}
