import { Button } from '@roofline/ui';
import { quote } from '../../copy/quote.ts';
import styles from './QuotePage.module.css';

/**
 * /q/:slug/measure: measuring windows in the phone's browser. A placeholder until that page is built (a separate piece
 * of work): the link and the route exist so the quote page and its QR code can point here.
 */
export function MeasurePage({ slug }: { slug: string }) {
  return (
    <div className={styles.page}>
      <main className={styles.column}>
        <section className={styles.plain}>
          <h1 className={styles.title}>{quote.browserSoonTitle}</h1>
          <p className={styles.lede}>{quote.browserSoonBody}</p>
          <Button href={`/q/${slug}`} variant="ghost" className={styles.linkButton}>
            {quote.browserSoonBack}
          </Button>
        </section>
      </main>
    </div>
  );
}
