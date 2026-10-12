import type { AgentValues, Role } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import type { CompanyBody, TeamBody } from '../../api/types.ts';

/*
 * The hooks behind the Settings window. `useCompany` is Task 15's too (it reads the company's name
 * and time zone), which is why it lives here and not in api/hooks.ts.
 */

/** Everything the owner may change about the company. An empty string clears a field. */
export type CompanyPatch = Partial<{
  name: string;
  legalName: string;
  phone: string;
  email: string;
  website: string;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
  timezone: string;
  logoUrl: string;
}>;

/** What can change about one member of the team. Send only what changed. */
export type MemberChanges = { role?: Role; canApproveSpend?: boolean; status?: 'active' | 'disabled' };

export type TeamMember = TeamBody['members'][number];
export type TeamInvite = TeamBody['invites'][number];

/** The company's details. Any member can read them. */
export function useCompany() {
  return useQuery({
    queryKey: keys.company,
    queryFn: ({ signal }) => apiFetch<CompanyBody>('/api/company', { signal }),
  });
}

/**
 * Saves the changed company details (owner only). The answer is the company as saved, so it replaces
 * what was loaded; the session is asked again because it carries the company's name.
 */
export function useUpdateCompany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: CompanyPatch) => apiFetch<CompanyBody>('/api/company', { method: 'PATCH', body: changes }),
    onSuccess: (company) => {
      queryClient.setQueryData(keys.company, company);
      // Not waited for: "Saved" should not wait on the session being read again
      void queryClient.invalidateQueries({ queryKey: keys.me });
    },
  });
}

/** The team: its members, and for the owner the invites still waiting (`invites` is [] for everyone else). */
export function useTeam() {
  return useQuery({
    queryKey: keys.team,
    queryFn: ({ signal }) => apiFetch<TeamBody>('/api/team', { signal }),
  });
}

/** Invites someone by email (owner only). A 409 means they are already on the team; a 403 that the owner must confirm their own email first. */
export function useInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invite: { email: string; role: Role }) =>
      apiFetch<TeamInvite>('/api/team/invites', { method: 'POST', body: invite }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.team }),
  });
}

/**
 * Changes a member's role, spending permission or status (owner only). A 400 means it would leave the company without an owner.
 * The session and the approvals are asked again too: when the member is the viewer, their own role
 * (and so the owner controls) changes with it.
 */
export function useUpdateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: { membershipId: string; changes: MemberChanges }) =>
      apiFetch<TeamMember>('/api/team/members/' + encodeURIComponent(update.membershipId), {
        method: 'PATCH',
        body: update.changes,
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.team }),
        queryClient.invalidateQueries({ queryKey: keys.me }),
        queryClient.invalidateQueries({ queryKey: keys.approvals }),
      ]).then(() => undefined),
  });
}

/** The agent rule values (G1 Task 17s). Only the fields that changed are sent. */
export type AgentValuesPatchBody = Partial<AgentValues>;

/** The values behind each agent rule. Any company admin may read them. */
export function useAgentValues() {
  return useQuery({
    queryKey: keys.agentValues,
    queryFn: ({ signal }) => apiFetch<AgentValues>('/api/agent-values', { signal }),
  });
}

/**
 * Saves the changed agent rule values (company admin only). The answer is the values as saved,
 * which replaces what was loaded.
 */
export function useUpdateAgentValues() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: AgentValuesPatchBody) =>
      apiFetch<AgentValues>('/api/agent-values', { method: 'PATCH', body: changes }),
    onSuccess: (values) => {
      queryClient.setQueryData(keys.agentValues, values);
    },
  });
}
