import type { CalendarConnectionView } from '@roofline/shared';
import { Banner, Button, Listbox, Panel, Skeleton, useToast, type ListboxOption, type ToastTone } from '@roofline/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { connections } from '../../copy/connections.ts';
import { useCompany } from './api.ts';
import { ConnectionTag, type ConnectionState } from './ConnectionTag.tsx';
import { useCalendarConnection, useCalendars, useChooseCalendar, useDisconnectCalendar } from './crm-api.ts';
import form from './form.module.css';
import styles from './CalendarConnection.module.css';

type Provider = 'google' | 'microsoft';

/** The zone a missing or unusable company zone falls back to. */
const FALLBACK_ZONE = 'America/Chicago';

/** What the `calendar` query value toasts, by value. */
const OUTCOMES = new Map<string, { message: string; tone: ToastTone }>([
  ['connected', { message: connections.toasts.connected, tone: 'success' }],
  ['failed', { message: connections.toasts.failed, tone: 'error' }],
  ['canceled', { message: connections.toasts.canceled, tone: 'info' }],
  ['not-set-up', { message: connections.toasts.notSetUp, tone: 'error' }],
]);

/** A moment as the company's zone shows it, never the browser's. */
function formatInZone(iso: string, zone: string): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  const when = new Date(iso);
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone }).format(when);
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: FALLBACK_ZONE }).format(when);
  }
}

/** The connect button: an anchor to the provider's sign-in, or a disabled button while the provider is not set up. */
function ConnectButton({ provider, configured, primary }: { provider: Provider; configured: boolean; primary: boolean }) {
  const variant = primary ? 'primary' : 'default';
  if (!configured) {
    return (
      <Button variant={variant} disabled>
        {connections.connect[provider]}
      </Button>
    );
  }
  return (
    <Button variant={variant} href={`/api/calendar/connect/${provider}`}>
      {connections.connect[provider]}
    </Button>
  );
}

/** The person's own calendar: connect it, pick the calendar appointments go to, or disconnect. */
export function CalendarConnection() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const handled = useRef(false);
  const company = useCompany();
  const connection = useCalendarConnection();
  const view = connection.data;
  const connected = view?.status === 'connected';
  const calendars = useCalendars(connected);
  const choose = useChooseCalendar();
  const disconnect = useDisconnectCalendar();
  const [confirming, setConfirming] = useState(false);

  // The address says how the connect round trip ended. Toast it once, then take it off the address.
  useEffect(() => {
    const outcome = params.get('calendar');
    if (outcome === null || handled.current) return;
    handled.current = true;
    const found = OUTCOMES.get(outcome);
    if (found) toast.show(found.message, found.tone);
    setParams({}, { replace: true });
  }, [params, setParams, toast]);

  const section = (body: ReactNode, state?: ConnectionState) => (
    <Panel title={connections.calendarTitle} actions={state ? <ConnectionTag state={state} /> : undefined}>
      {body}
    </Panel>
  );

  if (view === undefined) {
    if (connection.error) return section(<Banner tone="danger">{connections.loadFailed}</Banner>);
    return section(
      <div role="status">
        <Skeleton lines={3} />
        <span className="visually-hidden">{connections.loading}</span>
      </div>,
    );
  }

  if (view.provider === null) {
    const notSetUp = !view.configured.google || !view.configured.microsoft;
    return section(
      <div className={styles.stack}>
        {notSetUp ? <p className={form.help}>{connections.notConfigured}</p> : null}
        <div className={styles.actions}>
          <ConnectButton provider="google" configured={view.configured.google} primary={false} />
          <ConnectButton provider="microsoft" configured={view.configured.microsoft} primary={false} />
        </div>
      </div>,
      'off',
    );
  }

  if (view.status !== 'connected') {
    return section(<ReconnectBody view={view} provider={view.provider} />, view.status === 'error' || view.status === 'revoked' ? 'attention' : 'off');
  }

  const zone = company.data?.timezone ?? FALLBACK_ZONE;
  const calendarOptions: ListboxOption[] = calendars.data
    ? calendars.data.map((calendar) => ({ value: calendar.id, label: calendar.name }))
    : view.calendarId
      ? [{ value: view.calendarId, label: view.calendarName ?? view.calendarId }]
      : [];

  return section(
    <div className={styles.stack}>
      <dl className={form.facts}>
        <div className={form.fact}>
          <dt className={form.factLabel}>{connections.account}</dt>
          <dd className={form.factValue}>{view.accountEmail ?? ''}</dd>
        </div>
        <div className={form.fact}>
          <dt className={form.factLabel}>{connections.lastSyncedLabel}</dt>
          <dd className={`${form.factValue} ${view.lastSyncedAt ? form.mono : ''}`}>
            {view.lastSyncedAt ? formatInZone(view.lastSyncedAt, zone) : connections.neverSynced}
          </dd>
        </div>
      </dl>
      <Listbox
        className={styles.field}
        label={connections.calendarLabel}
        value={view.calendarId ?? ''}
        options={calendarOptions}
        disabled={choose.isPending}
        onChange={(calendarId) =>
          choose.mutate(calendarId, {
            onError: () => toast.show(connections.chooseFailed, 'error'),
          })
        }
      />
      {confirming ? (
        <div className={styles.confirm}>
          <p>{connections.disconnectConfirm}</p>
          <div className={styles.actions}>
            <Button
              variant="danger"
              busy={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(undefined, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast.show(connections.disconnected, 'success');
                  },
                  onError: () => toast.show(connections.disconnectFailed, 'error'),
                })
              }
            >
              {connections.confirmYes}
            </Button>
            <Button variant="default" onClick={() => setConfirming(false)}>
              {connections.confirmNo}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <Button variant="default" onClick={() => setConfirming(true)}>
            {connections.disconnect}
          </Button>
        </div>
      )}
    </div>,
    'connected',
  );
}

/** A connection that stopped working (or was never finished): say so, and offer the connect button again. */
function ReconnectBody({ view, provider }: { view: CalendarConnectionView; provider: Provider }) {
  const broken = view.status === 'error' || view.status === 'revoked';
  return (
    <div className={styles.stack}>
      {broken ? <Banner tone="danger">{connections.reconnectTitle}</Banner> : null}
      <div className={styles.actions}>
        <ConnectButton provider={provider} configured={view.configured[provider]} primary />
      </div>
    </div>
  );
}
