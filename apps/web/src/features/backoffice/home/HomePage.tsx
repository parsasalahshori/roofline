import { ORDER_STAGES } from '@roofline/shared';
import { Banner, Button, EmptyState, Icon, Select, Skeleton, Tag, UiLink } from '@roofline/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../../api/client.ts';
import { backoffice as copy } from '../../../copy/backoffice.ts';
import { AppleSheet } from '../AppleSheet.tsx';
import { useBackofficeSettings, useCreateQuote, useJobChoices, useOrders, useQuotes, type QuoteRow } from '../api.ts';
import { BackofficePage } from '../BackofficePage.tsx';
import { formatDollars, formatMoment, stageName } from '../format.ts';
import { isStuck } from '../orders/stuck.ts';
import styles from './home.module.css';

/** Back office home: recent quotes with New quote, and the orders by stage with how many are stuck. */
export function HomePage() {
  const [starting, setStarting] = useState(false);
  return (
    <BackofficePage
      tab="home"
      actions={
        <Button variant="primary" onClick={() => setStarting(true)}>
          <Icon name="plus" size={16} />
          {copy.home.newQuote}
        </Button>
      }
    >
      {() => (
        <>
          <div className={styles.columns}>
            <QuotesPanel onNew={() => setStarting(true)} />
            <OrdersPanel />
          </div>
          <NewQuoteSheet open={starting} onClose={() => setStarting(false)} />
        </>
      )}
    </BackofficePage>
  );
}

function quoteTotal(quote: QuoteRow): string | null {
  const total = quote.totals?.[quote.tier]?.totalCents;
  return typeof total === 'number' ? formatDollars(total) : null;
}

function QuotesPanel({ onNew }: { onNew: () => void }) {
  const quotes = useQuotes();
  return (
    <section aria-label={copy.home.quotesTitle}>
      <h3 className="bo-grouphead">{copy.home.quotesTitle}</h3>
      {quotes.isPending ? (
        <Skeleton lines={3} />
      ) : quotes.isError ? (
        <Banner tone="danger">{copy.loadFailed}</Banner>
      ) : quotes.data.length === 0 ? (
        <div className="bo-group">
          <EmptyState
            title={copy.home.quotesEmpty}
            body={copy.home.quotesEmptyBody}
            action={
              <Button variant="default" onClick={onNew}>
                {copy.home.newQuote}
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="bo-group">
          {quotes.data.slice(0, 8).map((quote) => (
            <li key={quote.id}>
              <UiLink href={'/backoffice/quotes/' + quote.id} className="bo-row" aria-label={copy.home.openQuote(quote.customerName)}>
                <span className="bo-row-main">
                  <b>{quote.customerName}</b>
                  <small className="bo-foot">{quote.address}</small>
                  <small className="bo-foot">{copy.home.quoteLine(copy.quoteStatus[quote.status], formatMoment(quote.updatedAt))}</small>
                </span>
                {quoteTotal(quote) ? <span className="bo-row-value">{quoteTotal(quote)}</span> : null}
                <Icon name="chev" size={16} className="bo-chev" />
              </UiLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OrdersPanel() {
  const orders = useOrders();
  const settings = useBackofficeSettings();
  const data = orders.data ?? [];
  const stuckTotal = data.filter((order) => isStuck(order, settings.data)).length;
  return (
    <section aria-label={copy.home.ordersTitle}>
      <h3 className="bo-grouphead">{copy.home.ordersTitle}</h3>
      {orders.isPending ? (
        <Skeleton lines={3} />
      ) : orders.isError ? (
        <Banner tone="danger">{copy.loadFailed}</Banner>
      ) : data.length === 0 ? (
        <p className="bo-foot bo-groupfoot">{copy.home.ordersEmpty}</p>
      ) : (
        <>
          {stuckTotal > 0 ? <Banner tone="warning">{copy.home.totalStuck(stuckTotal)}</Banner> : null}
          <ul className="bo-group">
            {ORDER_STAGES.map((stage) => {
              const here = data.filter((order) => order.stage === stage);
              const stuck = here.filter((order) => isStuck(order, settings.data)).length;
              return (
                <li key={stage}>
                  <UiLink href={'/backoffice/orders?stage=' + stage} className="bo-row">
                    <span className="bo-row-main">
                      <b>{stageName(stage)}</b>
                    </span>
                    {stuck > 0 ? <Tag tone="warn">{copy.home.stuckCount(stuck)}</Tag> : null}
                    <span className="bo-row-value">{here.length}</span>
                    <Icon name="chev" size={16} className="bo-chev" />
                  </UiLink>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function NewQuoteSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const jobs = useJobChoices(open);
  const create = useCreateQuote();
  const [jobId, setJobId] = useState('');
  const options = [
    { value: '', label: copy.home.jobPlaceholder },
    ...(jobs.data ?? []).map((job) => ({ value: job.id, label: copy.home.jobOption(job.customerName, job.addressLine) })),
  ];
  const message = create.error instanceof ApiError ? create.error.message : create.isError ? copy.saveFailed : null;

  function start() {
    create.mutate(jobId, {
      onSuccess: (id) => {
        onClose();
        void navigate('/backoffice/quotes/' + id);
      },
    });
  }

  return (
    <AppleSheet
      open={open}
      title={copy.home.newQuoteTitle}
      onClose={onClose}
      closeLabel={copy.home.newQuoteClose}
      footer={
        <Button variant="primary" busy={create.isPending} disabled={jobId === ''} onClick={start}>
          {create.isPending ? copy.home.startingQuote : copy.home.startQuote}
        </Button>
      }
    >
      <div className={styles.sheetBody}>
        {jobs.isPending ? (
          <Skeleton lines={2} />
        ) : jobs.data && jobs.data.length === 0 ? (
          <p className="bo-foot">{copy.home.noJobs}</p>
        ) : (
          <Select label={copy.home.pickJob} help={copy.home.pickJobHelp} value={jobId} onChange={setJobId} options={options} />
        )}
        {message ? <Banner tone="danger">{message}</Banner> : null}
      </div>
    </AppleSheet>
  );
}
