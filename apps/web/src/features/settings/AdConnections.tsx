import { Button, Card, EmptyState, Field, Skeleton, useToast } from '@roofline/ui';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { AdAccount, AdPlatform } from '../../api/types.ts';
import { useMe } from '../../api/hooks.ts';
import { connections } from '../../copy/connections.ts';
import { errors } from '../../copy/errors.ts';
import { settings } from '../../copy/settings.ts';
import { formErrors } from '../auth/formErrors.ts';
import {
  useAdAccounts,
  useCheckAdAccount,
  useConnectGoogle,
  useConnectMeta,
  useRemoveAdAccount,
} from './adsApi.ts';
import styles from './AdConnections.module.css';

/*
 * The ad accounts under Settings, Connections: one card for Google Ads and one for Facebook and
 * Instagram (Meta). The owner links, checks and removes; office sees each status and nothing to press.
 */

/** A Google Ads customer ID is ten digits; dashes and spaces are for reading only. */
const GOOGLE_ID = /^\d{10}$/;
const stripSeparators = (value: string) => value.replace(/[-\s]/g, '');

/** The account on this platform that is still linked. A removed one is not, and the form comes back. */
const linkedAccount = (accounts: AdAccount[], platform: AdPlatform) =>
  accounts.find((account) => account.platform === platform && account.status !== 'revoked');

type AdAccountCardProps = {
  heading: string;
  steps: string[];
  account: AdAccount | undefined;
  owner: boolean;
  /** The form that links a new account; shown to the owner only, while there is no account. */
  connectForm: ReactNode;
};

/** One platform's card: its steps, then its status and controls once an account exists. */
function AdAccountCard({ heading, steps, account, owner, connectForm }: AdAccountCardProps) {
  const headingId = useId();
  const toast = useToast();
  const check = useCheckAdAccount();
  const remove = useRemoveAdAccount();
  // A failed press is said in a toast; the provider's own words never reach the screen
  const reportError = (error: Error) => toast.show(formErrors(error, []).general ?? errors.generic, 'error');

  return (
    <Card as="section" className={styles.card} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>
        {heading}
      </h2>
      <p className={styles.stepsLabel}>{connections.stepsLabel}</p>
      <ol className={styles.steps}>
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      {account ? (
        <div className={styles.account}>
          <p className={styles.accountId}>{connections.accountId(account.externalAccountId)}</p>
          <p className={styles.statusRow}>
            <span className={styles.statusLabel}>{connections.statusLabel}</span>
            <span className={styles.status} data-status={account.status}>
              {connections.statuses[account.status]}
            </span>
          </p>
          {(account.status === 'pending' || account.status === 'error') && account.reason ? (
            <p className={styles.reason}>{connections.reasons[account.reason]}</p>
          ) : null}
          {owner ? (
            <div className={styles.actions}>
              {account.status === 'pending' || account.status === 'error' ? (
                <Button
                  variant="primary"
                  busy={check.isPending}
                  onClick={() => check.mutate(account.id, { onError: reportError })}
                >
                  {connections.checkAgain}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                busy={remove.isPending}
                onClick={() => remove.mutate(account.id, { onError: reportError })}
              >
                {connections.remove}
              </Button>
            </div>
          ) : null}
        </div>
      ) : owner ? (
        connectForm
      ) : (
        <p className={styles.note}>{connections.ownerOnly}</p>
      )}
    </Card>
  );
}

/** Links a Google Ads customer. The ID goes up as the person typed it; a wrong length is caught here first. */
function GoogleConnectForm() {
  const connect = useConnectGoogle();
  const toast = useToast();
  const [customerId, setCustomerId] = useState('');
  const [idError, setIdError] = useState<string | undefined>();
  const problems = formErrors(connect.error, ['customerId']);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = customerId.trim();
    if (!GOOGLE_ID.test(stripSeparators(typed))) {
      setIdError(connections.googleIdInvalid);
      return;
    }
    setIdError(undefined);
    connect.mutate(typed, {
      onError: (error) => {
        const general = formErrors(error, ['customerId']).general;
        if (general) toast.show(general, 'error');
      },
    });
  }

  return (
    <form onSubmit={submit} noValidate className={styles.form}>
      <Field
        label={connections.googleCustomerId}
        help={connections.googleCustomerIdHelp}
        name="customerId"
        inputMode="numeric"
        autoComplete="off"
        value={customerId}
        onChange={(event) => {
          setCustomerId(event.target.value);
          setIdError(undefined);
          connect.reset();
        }}
        error={idError ?? problems.forField('customerId')}
      />
      <Button
        type="submit"
        variant="primary"
        busy={connect.isPending}
        disabled={stripSeparators(customerId).length < 10}
      >
        {connections.adConnect}
      </Button>
    </form>
  );
}

/** Links a Meta ad account by its ID. The server checks the ID's shape and says so under the field. */
function MetaConnectForm() {
  const connect = useConnectMeta();
  const toast = useToast();
  const [adAccountId, setAdAccountId] = useState('');
  const problems = formErrors(connect.error, ['adAccountId']);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = adAccountId.trim();
    if (typed === '') return;
    connect.mutate(typed, {
      onError: (error) => {
        const general = formErrors(error, ['adAccountId']).general;
        if (general) toast.show(general, 'error');
      },
    });
  }

  return (
    <form onSubmit={submit} noValidate className={styles.form}>
      <Field
        label={connections.metaAdAccountId}
        help={connections.metaAdAccountIdHelp}
        name="adAccountId"
        autoComplete="off"
        value={adAccountId}
        onChange={(event) => {
          setAdAccountId(event.target.value);
          connect.reset();
        }}
        error={problems.forField('adAccountId')}
      />
      <Button type="submit" variant="primary" busy={connect.isPending} disabled={adAccountId.trim() === ''}>
        {connections.adConnect}
      </Button>
    </form>
  );
}

/** The slot for ad account connections under Connections: one card per platform. */
export function AdConnections() {
  const me = useMe();
  const accounts = useAdAccounts();
  const failure = accounts.error ?? me.error;

  if (!accounts.data || !me.data) {
    if (failure) {
      return (
        <EmptyState
          title={errors.generic}
          action={
            <Button
              variant="primary"
              onClick={() => {
                void accounts.refetch();
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
      <div role="status" className={styles.loading}>
        <Skeleton lines={4} />
        <span className="visually-hidden">{settings.loading}</span>
      </div>
    );
  }

  const owner = me.data.role === 'owner';
  const { managerId, businessId } = accounts.data;
  const list = accounts.data.accounts;

  return (
    <div className={styles.cards}>
      <AdAccountCard
        heading={connections.googleAds}
        steps={[
          connections.googleStepId,
          managerId !== null ? connections.googleStepManager(managerId) : connections.googleStepManagerSoon,
          connections.googleStepAccept,
          connections.googleStepCheck,
        ]}
        account={linkedAccount(list, 'google')}
        owner={owner}
        connectForm={<GoogleConnectForm />}
      />
      <AdAccountCard
        heading={connections.meta}
        steps={[
          businessId !== null ? connections.metaStepBusiness(businessId) : connections.metaStepBusinessSoon,
          connections.metaStepShare,
          connections.metaStepId,
          connections.metaStepConnect,
        ]}
        account={linkedAccount(list, 'meta')}
        owner={owner}
        connectForm={<MetaConnectForm />}
      />
    </div>
  );
}
