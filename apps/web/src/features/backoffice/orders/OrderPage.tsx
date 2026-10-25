import { ORDER_STAGES, type BackofficeOrder, type OrderEvent } from '@roofline/shared';
import { Banner, Button, EmptyState, Icon, Skeleton, Tag, UiLink } from '@roofline/ui';
import { useState } from 'react';
import { useParams } from 'react-router';
import { ApiError } from '../../../api/client.ts';
import { backoffice as copy } from '../../../copy/backoffice.ts';
import { useOrder } from '../api.ts';
import { BackofficePage } from '../BackofficePage.tsx';
import { formatDay, formatDollars, formatMoment, stageName } from '../format.ts';
import { MoveSheet } from './MoveSheet.tsx';
import styles from './orders.module.css';

const t = copy.orders;

/** What a message result says in plain words. */
export function resultWords(notified: OrderEvent['notified']): string[] {
  if (!notified) return [t.noMessages];
  return [t.sms[notified.sms], t.email[notified.email]];
}

/** One order: who and where, its place in the pipeline, the timeline, and the move. */
export function OrderPage() {
  const { orderId = '' } = useParams();
  const order = useOrder(orderId);
  const [moving, setMoving] = useState<{ open: boolean; stage: BackofficeOrder['stage'] | null }>({ open: false, stage: null });
  const missing = order.error instanceof ApiError && order.error.status === 404;

  return (
    <BackofficePage
      tab="orders"
      title={order.data?.customerName ?? t.backToOrders}
      subtitle={order.data?.address ?? ''}
      hideSections
      crumbs={[{ label: copy.tabs.orders, href: '/backoffice/orders' }, { label: order.data?.customerName ?? copy.titles.order }]}
      actions={
        <Button href="/backoffice/orders" variant="ghost">
          <Icon name="chevl" size={16} />
          {t.backToOrders}
        </Button>
      }
    >
      {({ canEdit }) =>
        order.isPending ? (
          <Skeleton lines={5} />
        ) : missing ? (
          <div className="bo-group">
            <EmptyState title={t.notFound} />
          </div>
        ) : order.isError ? (
          <Banner tone="danger">{t.loadFailed}</Banner>
        ) : (
          <Detail order={order.data} canEdit={canEdit} onMove={(stage) => setMoving({ open: true, stage })} moving={moving} onClose={() => setMoving({ open: false, stage: null })} />
        )
      }
    </BackofficePage>
  );
}

function Detail({
  order,
  canEdit,
  onMove,
  moving,
  onClose,
}: {
  order: BackofficeOrder;
  canEdit: boolean;
  onMove: (stage: BackofficeOrder['stage'] | null) => void;
  moving: { open: boolean; stage: BackofficeOrder['stage'] | null };
  onClose: () => void;
}) {
  const index = ORDER_STAGES.indexOf(order.stage);
  const next = ORDER_STAGES[index + 1];
  const events = [...order.events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return (
    <>
      <ul className="bo-group" aria-label={t.stageNow}>
        <li>
          <div className="bo-row">
            <span className="bo-row-main">
              <b>{t.stageNow}</b>
            </span>
            <Tag tone="brand">{stageName(order.stage)}</Tag>
            <span className="bo-row-value">{t.inStage(order.daysInStage)}</span>
          </div>
        </li>
        <li>
          <div className="bo-row">
            <span className="bo-row-main">
              <b>{t.summary(t.units(order.units), formatDollars(order.totalCents))}</b>
            </span>
          </div>
        </li>
        <li>
          <UiLink href={'/backoffice/quotes/' + order.quoteId} className="bo-row">
            <span className="bo-row-main">
              <b>{t.openQuote}</b>
            </span>
            <Icon name="chev" size={16} className="bo-chev" />
          </UiLink>
        </li>
        <li>
          {order.windowOrderId ? (
            <UiLink href="/estimator/windows" className="bo-row">
              <span className="bo-row-main">
                <b>{t.openFactoryOrder}</b>
                <small className="bo-foot">{t.factoryReleased}</small>
              </span>
              <Icon name="chev" size={16} className="bo-chev" />
            </UiLink>
          ) : (
            <div className="bo-row">
              <span className="bo-row-main">
                <b className="bo-row-value">{t.noFactoryOrder}</b>
              </span>
            </div>
          )}
        </li>
      </ul>

      {canEdit ? (
        <div className={styles.moves}>
          {next ? (
            <Button variant="primary" onClick={() => onMove(next)}>
              {t.moveNext(stageName(next))}
            </Button>
          ) : (
            <p className="bo-foot">{t.atEnd}</p>
          )}
          <Button variant="default" onClick={() => onMove(null)}>
            {t.moveTo}
          </Button>
        </div>
      ) : null}

      <h3 className="bo-grouphead">{t.timelineTitle}</h3>
      {events.length === 0 ? (
        <p className="bo-foot bo-groupfoot">{t.timelineEmpty}</p>
      ) : (
        <ol className="bo-group" aria-label={t.timelineLabel}>
          {events.map((event) => (
            <li key={event.id}>
              <div className={styles.event}>
                <div className={styles.eventTop}>
                  <b>{stageName(event.stage)}</b>
                  <span className="bo-foot">
                    {formatMoment(event.at)} {event.byUserName ? t.byPerson(event.byUserName) : t.byAutomatic}
                  </span>
                </div>
                <p className={styles.eventNote}>{event.note === '' ? t.noNote : event.note}</p>
                {event.plannedFor ? <p className="bo-foot">{t.planned(formatDay(event.plannedFor))}</p> : null}
                <div className={styles.results}>
                  {resultWords(event.notified).map((words) => (
                    <Tag key={words} tone={/not sent|failed/.test(words) ? 'warn' : 'neutral'}>
                      {words}
                    </Tag>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <MoveSheet order={order} open={moving.open} initialStage={moving.stage} onClose={onClose} />
    </>
  );
}
