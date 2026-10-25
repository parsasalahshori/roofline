import { ORDER_STAGES, type BackofficeOrder, type OrderStage } from '@roofline/shared';
import { Banner, EmptyState, Field, Icon, Segmented, Select, Skeleton, Tag, UiLink } from '@roofline/ui';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { backoffice as copy } from '../../../copy/backoffice.ts';
import { useBackofficeSettings, useOrders } from '../api.ts';
import { BackofficePage } from '../BackofficePage.tsx';
import { formatDollars, stageName } from '../format.ts';
import styles from './orders.module.css';
import { isStuck, stuckLimit } from './stuck.ts';

const t = copy.orders;
type View = 'board' | 'list';

const matches = (order: BackofficeOrder, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return q === '' || order.customerName.toLowerCase().includes(q) || order.address.toLowerCase().includes(q);
};

/** Orders: a board with a column per stage, or a list. Filter by words and by stage. */
export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>('board');
  const [query, setQuery] = useState('');
  const stageParam = params.get('stage');
  const stage: OrderStage | '' = ORDER_STAGES.find((s) => s === stageParam) ?? '';
  const orders = useOrders();
  const settings = useBackofficeSettings();

  const shown = (orders.data ?? []).filter((order) => (stage === '' || order.stage === stage) && matches(order, query));

  return (
    <BackofficePage tab="orders">
      {() => (
        <div className={styles.page}>
          <div className={styles.filters}>
            <Segmented<View>
              label={t.viewLabel}
              value={view}
              onChange={setView}
              options={[
                { value: 'board', label: t.board },
                { value: 'list', label: t.list },
              ]}
            />
            <Field className={styles.search} label={t.search} labelHidden placeholder={t.searchPlaceholder} type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
            <Select
              label={t.stageFilter}
              value={stage}
              onChange={(value) => setParams(value === '' ? {} : { stage: value }, { replace: true })}
              options={[{ value: '', label: t.allStages }, ...ORDER_STAGES.map((s) => ({ value: s, label: stageName(s) }))]}
            />
          </div>

          {orders.isPending ? (
            <Skeleton lines={4} />
          ) : orders.isError ? (
            <Banner tone="danger">{t.loadFailed}</Banner>
          ) : orders.data.length === 0 ? (
            <div className="bo-group">
              <EmptyState title={t.empty} body={t.emptyBody} />
            </div>
          ) : shown.length === 0 ? (
            <div className="bo-group">
              <EmptyState title={t.noMatches} body={t.noMatchesBody} />
            </div>
          ) : view === 'board' ? (
            <Board orders={shown} settings={settings.data} stage={stage} />
          ) : (
            <List orders={shown} settings={settings.data} />
          )}
        </div>
      )}
    </BackofficePage>
  );
}

type Settings = ReturnType<typeof useBackofficeSettings>['data'];

function Board({ orders, settings, stage }: { orders: BackofficeOrder[]; settings: Settings; stage: OrderStage | '' }) {
  const stages = stage === '' ? ORDER_STAGES : ORDER_STAGES.filter((s) => s === stage);
  return (
    <div className={styles.board} role="group" aria-label={t.boardLabel}>
      {stages.map((s) => {
        const here = orders.filter((order) => order.stage === s);
        return (
          <section key={s} className={styles.column} aria-label={stageName(s)}>
            <h3 className={styles.columnHead}>
              <span>{stageName(s)}</span>
              <span className={styles.count}>{t.columnCount(here.length)}</span>
            </h3>
            <div className={styles.cards}>
              {here.length === 0 ? <p className="bo-foot">{t.emptyColumn}</p> : here.map((order) => <OrderCard key={order.id} order={order} settings={settings} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function StuckTag({ order, settings }: { order: BackofficeOrder; settings: Settings }) {
  const limit = stuckLimit(order, settings);
  if (!isStuck(order, settings) || limit === null) return null;
  return (
    <Tag tone="warn" icon="alert" title={t.stuckTitle(order.daysInStage, limit)}>
      {t.stuck}
    </Tag>
  );
}

function OrderCard({ order, settings }: { order: BackofficeOrder; settings: Settings }) {
  return (
    <UiLink href={'/backoffice/orders/' + order.id} className="bo-card" aria-label={t.openOrder(order.customerName)}>
      <b className={styles.name}>{order.customerName}</b>
      <span className="bo-foot">{order.address}</span>
      <span className={styles.facts}>
        <span>{t.units(order.units)}</span>
        <span className={styles.total}>{formatDollars(order.totalCents)}</span>
      </span>
      <span className={styles.days}>
        <span className="bo-foot">{t.inStage(order.daysInStage)}</span>
        <StuckTag order={order} settings={settings} />
      </span>
    </UiLink>
  );
}

function List({ orders, settings }: { orders: BackofficeOrder[]; settings: Settings }) {
  return (
    <ul className="bo-group" aria-label={t.listLabel}>
      {orders.map((order) => (
        <li key={order.id}>
          <UiLink href={'/backoffice/orders/' + order.id} className="bo-row" aria-label={t.openOrder(order.customerName)}>
            <span className="bo-row-main">
              <b>{order.customerName}</b>
              <small className="bo-foot">{order.address}</small>
              <small className="bo-foot">{t.summary(t.units(order.units), formatDollars(order.totalCents))}</small>
            </span>
            <StuckTag order={order} settings={settings} />
            <Tag tone="neutral">{stageName(order.stage)}</Tag>
            <span className="bo-row-value">{t.inStage(order.daysInStage)}</span>
            <Icon name="chev" size={16} className="bo-chev" />
          </UiLink>
        </li>
      ))}
    </ul>
  );
}
