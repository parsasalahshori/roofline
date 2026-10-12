import type { AddOn, PricebookView, ProposalView, Scope } from '@roofline/shared';
import { useToast } from '@roofline/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ApiError, apiFetch } from '../../api/client.ts';
import { proposals } from '../../copy/proposals.ts';

/* The proposals API (E1 Task 8) is built separately; the shapes here follow the brief and the spec section 7. */

/** One option's changes. Only the keys present are sent. */
export type OptionPatch = {
  enabled?: boolean;
  name?: string;
  material?: Scope['material'];
  wastePercent?: number;
  markupPercent?: number;
  addOns?: AddOn[];
};

/** The PATCH /api/proposals/:id body: option changes keyed by option id, and the text message. */
export type ProposalPatch = {
  options?: ({ id: string } & OptionPatch)[];
  messageBody?: string;
};

export const proposalKey = (id: string) => ['proposal', id] as const;

/** GET /api/proposals/:id */
export function useProposal(id: string) {
  return useQuery({
    queryKey: proposalKey(id),
    queryFn: ({ signal }) => apiFetch<ProposalView>(`/api/proposals/${id}`, { signal }),
  });
}

/** GET /api/pricebook (owner and office only). `data` stays undefined for anyone else; the screen then shows saved totals. */
export function usePricebook() {
  return useQuery({
    queryKey: ['pricebook'],
    queryFn: ({ signal }) => apiFetch<PricebookView>('/api/pricebook', { signal }),
    retry: false,
  });
}

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof ApiError && error.message ? error.message : fallback;

/** PATCH /api/proposals/:id with a ProposalPatch. The answer (a ProposalView) replaces the cached proposal. A failure toasts the server's message (or proposals.saveFailed) and re-reads the proposal; onFailed receives the patch that failed. */
export function usePatchProposal(id: string, onFailed?: (patch: ProposalPatch) => void) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (patch: ProposalPatch) => apiFetch<ProposalView>(`/api/proposals/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: (view) => {
      queryClient.setQueryData(proposalKey(id), view);
    },
    onError: (error, patch) => {
      toast.show(messageOf(error, proposals.saveFailed), 'error');
      onFailed?.(patch);
      void queryClient.invalidateQueries({ queryKey: proposalKey(id) });
    },
  });
}

/** POST /api/proposals/:id/send -> { taskId }. On success navigates to `/approvals/<taskId>`. */
export function useSendProposal(id: string) {
  const navigate = useNavigate();
  const toast = useToast();
  return useMutation({
    mutationFn: () => apiFetch<{ taskId: string }>(`/api/proposals/${id}/send`, { method: 'POST' }),
    onSuccess: ({ taskId }) => {
      void navigate(`/approvals/${taskId}`);
    },
    onError: (error) => {
      toast.show(messageOf(error, proposals.sendFailed), 'error');
    },
  });
}

/** GET /api/proposals/:id/link -> { url }. Writes the url to navigator.clipboard, then toasts proposals.linkCopied (success). A failure toasts proposals.copyFailed (error). */
export function useCopyLink(id: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async () => {
      const { url } = await apiFetch<{ url: string }>(`/api/proposals/${id}/link`);
      await navigator.clipboard.writeText(url);
    },
    onSuccess: () => {
      toast.show(proposals.linkCopied, 'success');
      void queryClient.invalidateQueries({ queryKey: proposalKey(id) });
    },
    onError: (error) => {
      toast.show(messageOf(error, proposals.copyFailed), 'error');
    },
  });
}

/** POST /api/proposals/:id/revise -> ProposalView (the new draft). On success navigates to `/estimator/proposals/<new id>`. */
export function useReviseProposal(id: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  return useMutation({
    mutationFn: () => apiFetch<ProposalView>(`/api/proposals/${id}/revise`, { method: 'POST' }),
    onSuccess: (view) => {
      queryClient.setQueryData(proposalKey(view.id), view);
      void navigate(`/estimator/proposals/${view.id}`);
    },
    onError: (error) => {
      toast.show(messageOf(error, proposals.reviseFailed), 'error');
    },
  });
}

/** The address that downloads the PDF: `/api/proposals/<id>/pdf`. */
export function proposalPdfUrl(id: string): string {
  return `/api/proposals/${id}/pdf`;
}
