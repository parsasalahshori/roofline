import { ROLES, type Role } from '@roofline/shared';
import { Avatar, Button, EmptyState, Field, Listbox, Panel, Skeleton, Table, Tag, Td, Th, Toggle, Tr, useToast, type ListboxOption } from '@roofline/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { errors } from '../../copy/errors.ts';
import { settings } from '../../copy/settings.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { formErrors } from '../auth/formErrors.ts';
import { useInvite, useTeam, useUpdateMember, type MemberChanges, type TeamMember } from './api.ts';
import form from './form.module.css';
import styles from './TeamTab.module.css';

/*
 * The Team tab of Settings: who is on the team and what each may do. The owner changes roles,
 * spending approval and status, and invites people; everyone else gets the same list read-only.
 * A desktop shows the members as a table; a phone shows each one as a card, so nothing scrolls sideways.
 */

const ROLE_OPTIONS: ListboxOption<Role>[] = ROLES.map((role) => ({ value: role, label: settings.roles[role] }));

/** The date an invite expires, in the viewer's time zone, written out like Oct 18, 2026. */
const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' });

type MemberProps = {
  member: TeamMember;
  isOwner: boolean;
  updating: boolean;
  change: (changes: MemberChanges) => void;
};

/** The role: a list for the owner to pick from, the plain word for everyone else. */
function RoleControl({ member, isOwner, updating, change }: MemberProps) {
  if (!isOwner) return <>{settings.roles[member.role]}</>;
  return (
    <Listbox
      label={settings.team.roleFor(member.name)}
      value={member.role}
      options={ROLE_OPTIONS}
      className={styles.roleSelect}
      disabled={updating}
      onChange={(role) => change({ role })}
    />
  );
}

/** Spending delegation is for office members; an owner always may and a field rep never may. */
function SpendControl({ member, isOwner, updating, change }: MemberProps) {
  if (member.role === 'owner') return <>{settings.team.spendAlways}</>;
  if (member.role !== 'office') return <>{settings.team.spendNever}</>;
  return (
    <Toggle
      label={settings.team.spendFor(member.name)}
      labelHidden
      checked={member.canApproveSpend}
      disabled={!isOwner || updating}
      onChange={(next) => change({ canApproveSpend: next })}
    />
  );
}

/** Storm alert emails go to owners and office members; a field rep never gets them. */
function StormControl({ member, isOwner, updating, change }: MemberProps) {
  if (member.role === 'rep') return <>{settings.team.stormAlertsNever}</>;
  return (
    <Toggle
      label={settings.team.stormAlertsFor(member.name)}
      labelHidden
      checked={member.stormAlertEmail}
      disabled={!isOwner || updating}
      onChange={(next) => change({ stormAlertEmail: next })}
    />
  );
}

/** Active or turned off, always as an icon and a word. */
function StatusTag({ member }: { member: TeamMember }) {
  return member.status === 'active' ? (
    <Tag tone="ok" icon="check">
      {settings.team.statusActive}
    </Tag>
  ) : (
    <Tag icon="minus">{settings.team.statusOff}</Tag>
  );
}

/** The owner's button that turns a member off, or back on. */
function StatusButton({ member, updating, change, size }: MemberProps & { size: 'sm' | 'md' }) {
  const active = member.status === 'active';
  return (
    <Button
      variant="default"
      size={size}
      aria-label={active ? settings.team.turnOffFor(member.name) : settings.team.turnBackOnFor(member.name)}
      disabled={updating}
      onClick={() => change({ status: active ? 'disabled' : 'active' })}
    >
      {active ? settings.team.turnOff : settings.team.turnBackOn}
    </Button>
  );
}

/** A person: their initials, their name, and their email under it. */
function Person({ member }: { member: TeamMember }) {
  return (
    <div className={styles.person}>
      <Avatar name={member.name} size={32} />
      <div className={styles.who}>
        <span className={styles.name}>{member.name}</span>
        <span className={styles.email}>{member.email}</span>
      </div>
    </div>
  );
}

/** One line of the members table. Only the owner gets controls; everyone else reads the words. */
function MemberRow(props: MemberProps) {
  return (
    <Tr>
      <Td>
        <Person member={props.member} />
      </Td>
      <Td>
        <RoleControl {...props} />
      </Td>
      <Td>
        <SpendControl {...props} />
      </Td>
      <Td>
        <StormControl {...props} />
      </Td>
      <Td>
        <div className={styles.status}>
          <StatusTag member={props.member} />
          {props.isOwner ? <StatusButton {...props} size="sm" /> : null}
        </div>
      </Td>
    </Tr>
  );
}

/** One member as a card, for a phone: the person and their status on top, then each setting on a line of its own. */
function MemberCard(props: MemberProps) {
  return (
    <li className={styles.card}>
      <div className={styles.cardHead}>
        <Person member={props.member} />
        <StatusTag member={props.member} />
      </div>
      <div className={styles.fact}>
        <span className={styles.caption}>{settings.team.columns.role}</span>
        <RoleControl {...props} />
      </div>
      <div className={styles.line}>
        <span className={styles.caption}>{settings.team.columns.spend}</span>
        <SpendControl {...props} />
      </div>
      <div className={styles.line}>
        <span className={styles.caption}>{settings.team.columns.stormAlerts}</span>
        <StormControl {...props} />
      </div>
      {props.isOwner ? <StatusButton {...props} size="md" /> : null}
    </li>
  );
}

export function TeamTab() {
  const me = useMe();
  const team = useTeam();
  const updateMember = useUpdateMember();
  const invite = useInvite();
  const toast = useToast();
  const phone = useIsPhone();
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('rep');
  // The members whose change is still being saved; every change reports its own failure
  const [saving, setSaving] = useState<readonly string[]>([]);

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
      <Panel>
        <div role="status">
          <Skeleton lines={4} />
          <span className="visually-hidden">{settings.loading}</span>
        </div>
      </Panel>
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

  const propsFor = (member: TeamMember): MemberProps => ({
    member,
    isOwner,
    updating: saving.includes(member.id),
    change: (changes) => changeMember(member.id, changes),
  });

  return (
    <>
      <Panel title={settings.team.heading} tag={settings.team.count(members.length)} padded={false}>
        {phone ? (
          <ul className={styles.cards} aria-label={settings.team.tableLabel}>
            {members.map((member) => (
              <MemberCard key={member.id} {...propsFor(member)} />
            ))}
          </ul>
        ) : (
          <Table regionLabel={settings.team.tableLabel}>
            <thead>
              <tr>
                <Th>{settings.team.columns.name}</Th>
                <Th>{settings.team.columns.role}</Th>
                <Th>{settings.team.columns.spend}</Th>
                <Th>{settings.team.columns.stormAlerts}</Th>
                <Th>{settings.team.columns.status}</Th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <MemberRow key={member.id} {...propsFor(member)} />
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      {isOwner ? (
        <form onSubmit={submitInvite} noValidate>
          <Panel title={settings.team.inviteHeading}>
            <div className={form.grid}>
              <Field
                label={settings.team.inviteEmail}
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                error={problems.forField('email')}
              />
              <Listbox label={settings.team.inviteRole} value={inviteRole} options={ROLE_OPTIONS} onChange={setInviteRole} />
              <div className={form.span}>
                <Button type="submit" variant="primary" busy={invite.isPending}>
                  {settings.team.sendInvite}
                </Button>
              </div>
            </div>
          </Panel>
        </form>
      ) : null}

      {isOwner && invites.length > 0 ? (
        <Panel title={settings.team.pendingHeading} tag={String(invites.length)} padded={false}>
          <Table regionLabel={settings.team.pendingTableLabel}>
            <thead>
              <tr>
                <Th>{settings.team.pendingColumns.email}</Th>
                <Th>{settings.team.pendingColumns.role}</Th>
                <Th numeric>{settings.team.pendingColumns.expires}</Th>
              </tr>
            </thead>
            <tbody>
              {invites.map((pending) => (
                <Tr key={pending.id}>
                  <Td className={styles.pendingEmail}>{pending.email}</Td>
                  <Td>{settings.roles[pending.role]}</Td>
                  <Td numeric>
                    <time dateTime={pending.expiresAt}>{formatDate(pending.expiresAt)}</time>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      ) : null}
    </>
  );
}
