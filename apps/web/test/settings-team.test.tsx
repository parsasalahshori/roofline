import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamBody } from '../src/api/types.ts';
import { settings } from '../src/copy/settings.ts';
import { TeamTab } from '../src/features/settings/TeamTab.tsx';
import { ACCOUNT, renderAt, stubApi } from './helpers.tsx';

/** The team as the server holds it. Each test gets a fresh copy, which its PATCH and POST answers change. */
function makeTeam(): TeamBody {
  return {
    members: [
      { id: 'm1', userId: 'u1', name: 'Sam Roofer', email: 'sam@example.com', role: 'owner', canApproveSpend: true, status: 'active' },
      { id: 'm2', userId: 'u2', name: 'Olive Office', email: 'olive@example.com', role: 'office', canApproveSpend: false, status: 'active' },
      { id: 'm3', userId: 'u3', name: 'Ray Rep', email: 'ray@example.com', role: 'rep', canApproveSpend: false, status: 'active' },
    ],
    invites: [{ id: 'i1', email: 'new@example.com', role: 'rep', expiresAt: '2026-10-18T12:00:00.000Z' }],
  };
}

let api: ReturnType<typeof stubApi>;
let team: TeamBody;

beforeEach(() => {
  team = makeTeam();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A PATCH to one member changes that member in `team`, and answers the member as it now is. */
function patchMember(membershipId: string) {
  return ({ body }: { body: unknown }) => {
    const member = team.members.find((candidate) => candidate.id === membershipId)!;
    Object.assign(member, body as Partial<TeamBody['members'][number]>);
    return { body: member };
  };
}

/** Signed in as the owner, with the team as it is now. */
function ownerRoutes() {
  return {
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/team': () => ({ body: team }),
    'PATCH /api/team/members/m1': patchMember('m1'),
    'PATCH /api/team/members/m2': patchMember('m2'),
    'PATCH /api/team/members/m3': patchMember('m3'),
  };
}

describe('team tab', () => {
  it('owner turns on spend approval for an office member', async () => {
    api = stubApi(ownerRoutes());
    const { user } = renderAt(<TeamTab />);

    const spend = await screen.findByRole('switch', { name: settings.team.spendFor('Olive Office') });
    expect(spend).toHaveAttribute('aria-checked', 'false');
    await user.click(spend);

    await waitFor(() => expect(api.sent('PATCH /api/team/members/m2')).toEqual([{ canApproveSpend: true }]));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: settings.team.spendFor('Olive Office') })).toHaveAttribute('aria-checked', 'true'),
    );
  });

  it('owner changes a role', async () => {
    api = stubApi(ownerRoutes());
    const { user } = renderAt(<TeamTab />);

    await user.selectOptions(await screen.findByLabelText(settings.team.roleFor('Ray Rep')), 'office');

    await waitFor(() => expect(api.sent('PATCH /api/team/members/m3')).toEqual([{ role: 'office' }]));
  });

  it('owner turns a member off and back on', async () => {
    api = stubApi(ownerRoutes());
    const { user } = renderAt(<TeamTab />);

    await user.click(await screen.findByRole('button', { name: settings.team.turnOffFor('Ray Rep') }));
    await waitFor(() => expect(api.sent('PATCH /api/team/members/m3')).toEqual([{ status: 'disabled' }]));

    const row = await screen.findByRole('row', { name: /Ray Rep/ });
    await waitFor(() => expect(within(row).getByText(settings.team.statusOff)).toBeInTheDocument());
    await user.click(within(row).getByRole('button', { name: settings.team.turnBackOnFor('Ray Rep') }));

    await waitFor(() =>
      expect(api.sent('PATCH /api/team/members/m3')).toEqual([{ status: 'disabled' }, { status: 'active' }]),
    );
  });

  it('owner invites a teammate', async () => {
    api = stubApi({
      ...ownerRoutes(),
      'POST /api/team/invites': () => {
        const invite = { id: 'i2', email: 'jo@example.com', role: 'office' as const, expiresAt: '2026-10-18T12:00:00.000Z' };
        team.invites.push(invite);
        return { status: 201, body: invite };
      },
    });
    const { user } = renderAt(<TeamTab />);

    await user.type(await screen.findByLabelText(settings.team.inviteEmail), 'jo@example.com');
    await user.selectOptions(screen.getByLabelText(settings.team.inviteRole), 'office');
    await user.click(screen.getByRole('button', { name: settings.team.sendInvite }));

    await waitFor(() => expect(api.sent('POST /api/team/invites')).toEqual([{ email: 'jo@example.com', role: 'office' }]));
    await screen.findByText(settings.team.inviteSent('jo@example.com'));
    expect(screen.getByLabelText(settings.team.inviteEmail)).toHaveValue('');
    expect(screen.getByLabelText(settings.team.inviteRole)).toHaveValue('office');
  });

  it('last owner error shows as a toast', async () => {
    api = stubApi({
      ...ownerRoutes(),
      'PATCH /api/team/members/m1': () => ({ status: 400, body: { error: 'Your company needs at least one owner.' } }),
    });
    const { user } = renderAt(<TeamTab />);

    await user.click(await screen.findByRole('button', { name: settings.team.turnOffFor('Sam Roofer') }));

    await screen.findByText('Your company needs at least one owner.');
  });

  it('a refused change is still reported when another change follows at once', async () => {
    api = stubApi({
      ...ownerRoutes(),
      'PATCH /api/team/members/m2': () => ({ status: 400, body: { error: 'Please choose yes or no.' } }),
    });
    renderAt(<TeamTab />);

    const spend = await screen.findByRole('switch', { name: settings.team.spendFor('Olive Office') });
    const turnOffRay = screen.getByRole('button', { name: settings.team.turnOffFor('Ray Rep') });
    // Both clicks in one synchronous block, so the second change starts before the first one is answered
    await act(async () => {
      fireEvent.click(spend);
      fireEvent.click(turnOffRay);
    });

    await screen.findByText('Please choose yes or no.');
    await waitFor(() => expect(api.sent('PATCH /api/team/members/m3')).toEqual([{ status: 'disabled' }]));
  });

  it('an invite the server refuses shows as a toast', async () => {
    api = stubApi({
      ...ownerRoutes(),
      'POST /api/team/invites': () => ({ status: 409, body: { error: 'That person is already on your team.' } }),
    });
    const { user } = renderAt(<TeamTab />);

    await user.type(await screen.findByLabelText(settings.team.inviteEmail), 'olive@example.com');
    await user.click(screen.getByRole('button', { name: settings.team.sendInvite }));

    await screen.findByText('That person is already on your team.');
  });

  it('an email problem shows under the email field', async () => {
    api = stubApi({
      ...ownerRoutes(),
      'POST /api/team/invites': () => ({
        status: 400,
        body: { error: 'Please enter a valid email address.', field: 'email' },
      }),
    });
    const { user } = renderAt(<TeamTab />);

    await user.type(await screen.findByLabelText(settings.team.inviteEmail), 'nope');
    await user.click(screen.getByRole('button', { name: settings.team.sendInvite }));

    await screen.findByText('Please enter a valid email address.');
    expect(screen.getByLabelText(settings.team.inviteEmail)).toHaveAttribute('aria-invalid', 'true');
  });

  it('pending invites show when they expire', async () => {
    api = stubApi(ownerRoutes());
    renderAt(<TeamTab />);

    expect(await screen.findByRole('heading', { name: settings.team.pendingHeading })).toBeInTheDocument();
    const expires = new Date('2026-10-18T12:00:00.000Z').toLocaleDateString('en-US', { dateStyle: 'medium' });
    const item = (await screen.findByText('new@example.com')).closest('li');
    expect(item).toHaveTextContent(settings.team.pendingExpires(expires));
  });

  it('office sees a read-only list', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'office' } }),
      'GET /api/team': () => ({ body: { ...team, invites: [] } }),
    });
    renderAt(<TeamTab />);

    expect(await screen.findByText('Sam Roofer')).toBeInTheDocument();
    expect(screen.getByText('Olive Office')).toBeInTheDocument();
    expect(screen.getByText('Ray Rep')).toBeInTheDocument();
    expect(screen.queryByLabelText(settings.team.inviteEmail)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Turn (off|back on)/ })).toBeNull();
    expect(screen.queryByLabelText(settings.team.roleFor('Ray Rep'))).toBeNull();
    expect(within(screen.getByRole('row', { name: /Ray Rep/ })).getByText(settings.roles.rep)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: settings.team.spendFor('Olive Office') })).toBeDisabled();
    expect(screen.queryByRole('heading', { name: settings.team.pendingHeading })).toBeNull();
  });

  it('only office members get a spending switch', async () => {
    api = stubApi(ownerRoutes());
    renderAt(<TeamTab />);

    await screen.findByRole('switch', { name: settings.team.spendFor('Olive Office') });
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(within(screen.getByRole('row', { name: /Sam Roofer/ })).getByText(settings.team.spendAlways)).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Ray Rep/ })).getByText(settings.team.spendNever)).toBeInTheDocument();
  });
});
