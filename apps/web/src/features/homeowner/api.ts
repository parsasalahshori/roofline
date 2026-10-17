import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import type { PublicProposalView } from '@roofline/shared';
import { ApiError } from '../../api/client.ts';
import { common } from '../../copy/common.ts';
import { errors } from '../../copy/errors.ts';

export type SignBody = { optionId: string; consent: true; signerName: string; typedSignature: string; drawnSignature?: string };
export type DeclineBody = { reason?: string };

/** React Query key for the proposal read. */
export const publicProposalKey = (token: string): readonly unknown[] => ['public-proposal', token];

/** The public path of a proposal, or of one of its actions when `suffix` is given (such as "/sign"). */
const proposalPath = (token: string, suffix = ''): string => `/api/public/proposals/${encodeURIComponent(token)}${suffix}`;

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Talks JSON to the public (no session) proposal API. Same origin, no cookies, and never a
 * redirect on 401: a homeowner has no session to lose. Resolves with the parsed body of a 2xx
 * answer (undefined for 204 or an empty body); anything else is an ApiError whose `latest` is the
 * parsed error body (a 410 carries `{ error, companyPhone }` there).
 */
async function publicFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { method = 'GET', body } = init;

  let response: Response;
  let text: string;
  try {
    response = await fetch(path, {
      method,
      credentials: 'omit',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await response.text();
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError(0, common.networkError);
  }

  let parsed: unknown = undefined;
  let readable = true;
  if (text !== '') {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      readable = false;
    }
  }

  if (response.ok) {
    // Text that is not JSON behind a good status (a page served in place of the API) is no answer we can use.
    if (!readable) throw new ApiError(response.status, errors.generic);
    return parsed as T;
  }

  const failure = readable && isRecord(parsed) ? parsed : {};
  throw new ApiError(
    response.status,
    typeof failure.error === 'string' && failure.error !== '' ? failure.error : errors.generic,
    typeof failure.field === 'string' ? failure.field : undefined,
    readable ? parsed : undefined,
  );
}

/** How often a signed proposal is asked again while its signed copy is being made. */
export const SIGNED_PDF_POLL_MS = 5000;
/** The signed-copy poll stops after this many reads; the page then says to check back. */
export const SIGNED_PDF_POLL_LIMIT = 24;

/** True while the proposal is signed and its signed copy is not ready yet. */
const waitingForPdf = (data: PublicProposalView | undefined): boolean => data?.status === 'signed' && data.signed?.pdfReady === false;

/**
 * GET /api/public/proposals/:token. A 404 or 410 is an ApiError whose `status` says which; on 410 `error.latest` is the body `{ error, companyPhone }`.
 * While the proposal is signed and its signed copy is still being made, it is read again every 5 seconds (about 2 minutes at most), so the download appears without a reload.
 */
export function usePublicProposal(token: string): UseQueryResult<PublicProposalView, ApiError> {
  return useQuery<PublicProposalView, ApiError>({
    queryKey: publicProposalKey(token),
    queryFn: () => publicFetch<PublicProposalView>(proposalPath(token)),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      waitingForPdf(query.state.data) && query.state.dataUpdateCount < SIGNED_PDF_POLL_LIMIT ? SIGNED_PDF_POLL_MS : false,
  });
}

/**
 * How many answers the page has had for the proposal so far (the first read counts), so it can tell whether the poll for
 * the signed copy is still going: it stops after SIGNED_PDF_POLL_LIMIT. Pass the query's `dataUpdatedAt`: reading it in
 * the page's render is what draws the page again after every answer, even one that changed nothing.
 */
export function useProposalReads(token: string, answeredAt: number): number {
  const client = useQueryClient();
  return answeredAt === 0 ? 0 : (client.getQueryState(publicProposalKey(token))?.dataUpdateCount ?? 0);
}

/** POST .../view once per mount of the calling component (StrictMode safe) when `ready` is true. `optionId` is optional. */
export function useRecordView(token: string, ready: boolean): void {
  // The token this mount has already recorded a view for. A ref survives StrictMode's double effect run, so one mount posts once.
  const recordedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || recordedFor.current === token) return;
    recordedFor.current = token;
    // A failed view event is not the homeowner's problem: it is dropped without a word.
    void publicFetch(proposalPath(token, '/view'), { method: 'POST', body: {} }).catch(() => undefined);
  }, [ready, token]);
}

/**
 * POST .../sign. On success invalidates publicProposalKey(token). A 409 (signed on another phone, or
 * expired) or a 410 (the link is gone) invalidates it too, so the page underneath shows what happened.
 */
export function useSignProposal(token: string): UseMutationResult<{ signed: true }, ApiError, SignBody> {
  const queryClient = useQueryClient();
  return useMutation<{ signed: true }, ApiError, SignBody>({
    mutationFn: (body) => publicFetch<{ signed: true }>(proposalPath(token, '/sign'), { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: publicProposalKey(token) });
    },
    onError: (error) => {
      if (error.status === 409 || error.status === 410) void queryClient.invalidateQueries({ queryKey: publicProposalKey(token) });
    },
  });
}

/** POST .../decline. On success invalidates publicProposalKey(token). */
export function useDeclineProposal(token: string): UseMutationResult<void, ApiError, DeclineBody> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, DeclineBody>({
    mutationFn: (body) => publicFetch<void>(proposalPath(token, '/decline'), { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: publicProposalKey(token) });
    },
  });
}

/** The same-origin URL of the signed PDF: `/api/public/proposals/${token}/signed.pdf`. */
export function signedPdfUrl(token: string): string {
  return `/api/public/proposals/${encodeURIComponent(token)}/signed.pdf`;
}
