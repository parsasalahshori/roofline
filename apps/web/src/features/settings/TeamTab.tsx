import { ROLES, type Role } from '@roofline/shared';
import { Button, Card, EmptyState, Field, Select, Skeleton, Toggle, useToast } from '@roofline/ui';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { errors } from '../../copy/errors.ts';
import { settings } from '../../copy/settings.ts';
import { formErrors } from '../auth/formErrors.ts';
import { useInvite, useTeam, useUpdateMember, type MemberChanges, type TeamMember } from './api.ts';
import styles from './TeamTab.module.css';

/*
 * The Team tab of Settings: who is on the team and what each may do. The owner changes roles,
 * spending approval and status, and invites people; everyone else gets the same list read-only.
 */

const ROLE_OPTIONS = ROLES.map((role) => ({ value: role, label: settings.roles[role] }));

/** A Select's text back to a role. Anything else is not a role, and is ignored. */
const toRole = (value: string): Role | undefined => ROLES.find((role) => role === value);

/** The date an invite expires, in the viewer's time zone, written out like Oct 18, 2026. */
const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' });

type MemberRowProps = {
  member: TeamMember;
  isOwner: boolean;
  updating: boolean;
  change: (changes: MemberChanges) => void;
};

/** One line of the members table. Only the owner gets controls; everyone else reads the words. */
function MemberRow({ member, isOwner, updating, change }: MemberRowProps) {
  const active = member.status === 'active';
  return (
    <tr role="row">
      <td role="cell" data-label={settings.team.columns.name}>{member.name}</td>
      <td role="cell" data-label={settings.team.columns.email}>{member.email}</td>
      <td role="cell" data-label={settings.team.columns.role}>
        {isOwner ? (
          <Select
            label={settings.team.roleFor(member.name)}
            value={member.role}
            options={ROLE_OPTIONS}
            className={styles.roleSelect}
            disabled={updating}
            onChange={(value) => {
              const role = toRole(value);
              if (role) change({ role });
            }}
          />
        ) : (
          settings.roles[member.role]
        )}
      </td>
      <td role="cell" data-label={settings.team.columns.spend}>
        {/* Spending delegation is for office members; an owner always may and a field rep never may */}
        {member.role === 'office' ? (
          <Toggle
            label={settings.team.spendFor(member.name)}
            labelHidden
            checked={member.canApproveSpend}
            disabled={!isOwner || updating}
            onChange={(next) => change({ canApproveSpend: next })}
          />
        ) : member.role === 'owner' ? (
          settings.team.spendAlways
        ) : (
          settings.team.spendNever
        )}
      </td>
      <td role="cell" data-label={settings.team.columns.stormAlerts}>
        {/* Storm alert emails go to owners and office members; a field rep never gets them */}
        {member.role === 'rep' ? (
          settings.team.stormAlertsNever
        ) : (
          <Toggle
            label={settings.team.stormAlertsFor(member.name)}
            labelHidden
            checked={member.stormAlertEmail}
            disabled={!isOwner || updating}
            onChange={(next) => change({ stormAlertEmail: next })}
          />
        )}
      </td>
      <td role="cell" data-label={settings.team.columns.status}>
        <div className={styles.statusCell}>
          <span data-status={member.status}>{active ? settings.team.statusActive : settings.team.statusOff}</span>
          {isOwner ? (
            <Button
              variant="ghost"
              aria-label={active ? settings.team.turnOffFor(member.name) : settings.team.turnBackOnFor(member.name)}
              disabled={updating}
              onClick={() => change({ status: active ? 'disabled' : 'active' })}
            >
              {active ? settings.team.turnOff : settings.team.turnBackOn}
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

export function TeamTab() {
  const me = useMe();
  const team = useTeam();
  const updateMember = useUpdateMember();
  const invite = useInvite();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('rep');
  // The members whose change is still being saved; every change reports its own failure
  const [saving, setSaving] = useState<readonly string[]>([]);
  const inviteHeadingId = useId();
  const pendingHeadingId = useId();

  // Shown only while there is nothing to show instead: a failed read with no earlier answer to keep
  const failure = team.error ?? me.error;
  if (!me.data || !team.data) {
    if (failure) {
      return (
        <EmptyState
          title={failure instanceof ApiError ? failure.message : errors.generic}
          action={
            <Button
              variant="primary"
              onClick={() => {
                void team.refetch();
                void me.refetch();
              }}
            >
              {errors.tryAgain}
            </Button>
          }
        />
      );
    }
    return (
      <div role="status">
        <Skeleton lines={4} />
        <span className="visually-hidden">{settings.loading}</span>
      </div>
    );
  }

  const isOwner = me.data.role === 'owner';
  const { members, invites } = team.data;
  const problems = formErrors(invite.error, ['email']);

  // A failed change is said in a toast, whichever member it was for
  const reportError = (error: Error) => toast.show(formErrors(error, []).general ?? errors.generic, 'error');

  function changeMember(membershipId: string, changes: MemberChanges) {
    setSaving((ids) => [...ids, membershipId]);
    void updateMember
      .mutateAsync({ membershipId, changes })
      .catch(reportError)
      .finally(() => setSaving((ids) => ids.filter((id) => id !== membershipId)));
  }

  function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    invite.mutate(
      { email: address, role: inviteRole },
      {
        onSuccess: () => {
          toast.show(settings.team.inviteSent(address), 'success');
          setEmail('');
        },
        onError: (error) => {
          // A field error belongs under the email field; anything else (already on the team, unverified owner) is a toast
          const general = formErrors(error, ['email']).general;
          if (general) toast.show(general, 'error');
        },
      },
    );
  }

  return (
    <div className={styles.page}>
      <Card padded={false}>
        <div className={styles.tableWrap}>
          <table role="table" className={styles.table} aria-label={settings.team.tableLabel}>
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col">{settings.team.columns.name}</th>
                <th scope="col">{settings.team.columns.email}</th>
                <th scope="col">{settings.team.columns.role}</th>
                <th scope="col">{settings.team.columns.spend}</th>
                <th scope="col">{settings.team.columns.stormAlerts}</th>
                <th scope="col">{settings.team.columns.status}</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {members.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  isOwner={isOwner}
                  updating={saving.includes(member.id)}
                  change={(changes) => changeMember(member.id, changes)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {isOwner ? (
        <Card as="section" aria-labelledby={inviteHeadingId}>
          <h2 id={inviteHeadingId} className={styles.heading}>
            {settings.team.inviteHeading}
          </h2>
          <form onSubmit={submitInvite} noValidate className={styles.inviteForm}>
            <Field
              label={settings.team.inviteEmail}
              name="email"
              type="email"
              autoComplete="email"
              className={styles.inviteEmail}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              error={problems.forField('email')}
            />
            <Select
              label={settings.team.inviteRole}
              value={inviteRole}
              options={ROLE_OPTIONS}
              className={styles.inviteRole}
              onChange={(value) => {
                const role = toRole(value);
                if (role) setInviteRole(role);
              }}
            />
            <Button type="submit" variant="primary" busy={invite.isPending}>
              {settings.team.sendInvite}
            </Button>
          </form>
        </Card>
      ) : null}

      {isOwner && invites.length > 0 ? (
        <Card as="section" aria-labelledby={pendingHeadingId}>
          <h2 id={pendingHeadingId} className={styles.heading}>
            {settings.team.pendingHeading}
          </h2>
          <ul className={styles.pendingList}>
            {invites.map((pending) => (
              <li key={pending.id} className={styles.pendingItem}>
                <span className={styles.pendingEmail}>{pending.email}</span>
                <span>{settings.roles[pending.role]}</span>
                <span>{settings.team.pendingExpires(formatDate(pending.expiresAt))}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
