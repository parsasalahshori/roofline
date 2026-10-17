import { Button, Skeleton } from '@roofline/ui';
import type { PublicQuoteConfig } from '@roofline/shared';
import { useEffect, useState } from 'react';
import { PublicHeader } from '../public/PublicHeader.tsx';
import { usePublicBrand } from '../public/usePublicBrand.ts';
import { homeownerMeasure as copy } from '../../copy/homeownerMeasure.ts';
import { detectDevice, type Device } from '../../lib/device.ts';
import { quoteApi, QuoteApiError } from './api.ts';
import { MeasureFlow } from './measure/MeasureFlow.tsx';
import { QrCode } from './QrCode.tsx';
import styles from './measure/MeasureFlow.module.css';
import q from './QuotePage.module.css';

/**
 * /q/:slug/measure: measuring windows in the phone's browser. An iPhone is sent to the company's app (with a way to
 * measure in the browser anyway), a computer shows a QR code to open this page on a phone, and an Android phone (or
 * an iPhone that chose the browser) gets the measuring flow. `?request=` is the quote's id: the estimate this opens.
 */
export function MeasurePage({ slug }: { slug: string }) {
  const [config, setConfig] = useState<{ data?: PublicQuoteConfig; error?: QuoteApiError; attempt: number }>({ attempt: 0 });
  const [device] = useState<Device>(() => detectDevice());
  const [anyway, setAnyway] = useState(false);
  const quoteId = new URLSearchParams(window.location.search).get('request');

  useEffect(() => {
    const controller = new AbortController();
    quoteApi.config(slug, controller.signal).then(
      (data) => setConfig((s) => ({ data, attempt: s.attempt })),
      (error: unknown) => {
        if (error instanceof QuoteApiError) setConfig((s) => ({ error, attempt: s.attempt }));
      },
    );
    return () => controller.abort();
  }, [slug, config.attempt]);

  // The company's one colour fills the brand slot (the main button), as on the quote page.
  usePublicBrand(config.data?.accentColor);

  useEffect(() => {
    if (config.data) document.title = copy.pageTitle(config.data.companyName);
  }, [config.data]);

  if (config.error) {
    const missing = config.error.status === 404;
    return (
      <main className={q.page}>
        <div className={q.column}>
          <h1 className={q.title}>{missing ? copy.notFoundTitle : copy.loadFailed}</h1>
          {missing ? <p className={q.text}>{copy.notFoundBody}</p> : <Button onClick={() => setConfig((s) => ({ attempt: s.attempt + 1 }))}>{copy.retry}</Button>}
        </div>
      </main>
    );
  }
  if (!config.data) {
    return (
      <main className={q.page}>
        <div className={q.column} role="status">
          <span className="visually-hidden">{copy.loading}</span>
          <Skeleton lines={3} />
        </div>
      </main>
    );
  }
  const c = config.data;
  const app = c.homeownerApp;
  const backHref = `/q/${slug}`;

  return (
    <div className={`${q.page} ${styles.touch}`} data-measure-device={device}>
      <PublicHeader name={c.companyName} logoUrl={c.logoUrl} phone={c.phone} />
      {device === 'iphone' && app !== null && !anyway ? (
        <main className={q.column}>
          <section className={q.card} data-gate="iphone">
            <h1 className={q.title}>{copy.iphoneTitle}</h1>
            <p className={q.text}>{copy.iphoneBody(app.name)}</p>
            <Button href={app.url} size="lg" className={q.primary} target="_blank" rel="noopener noreferrer">
              {copy.iphoneButton(app.name)}
            </Button>
            <Button variant="ghost" className={q.secondary} onClick={() => setAnyway(true)}>
              {copy.iphoneAnyway}
            </Button>
          </section>
        </main>
      ) : device === 'desktop' ? (
        <main className={q.column}>
          <section className={q.card} data-gate="desktop">
            <h1 className={q.title}>{copy.desktopTitle}</h1>
            <p className={q.text}>{copy.desktopBody}</p>
            <div className={q.qr} data-qr-block="">
              <QrCode value={`${window.location.origin}${window.location.pathname}${window.location.search}`} label={copy.desktopQrAlt} className={q.qrImage} />
            </div>
            <Button href={backHref} variant="ghost" className={q.linkButton}>
              {copy.desktopBack}
            </Button>
          </section>
        </main>
      ) : (
        <MeasureFlow slug={slug} quoteId={quoteId} />
      )}
    </div>
  );
}
