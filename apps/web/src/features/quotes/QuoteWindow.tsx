import { EmptyState } from '@roofline/ui';
import { quotes } from '../../copy/quotes.ts';

/** The quote screen skeleton inside a job: a line until quotes are built. */
export function QuoteWindow() {
  return <EmptyState title={quotes.comingSoon} />;
}
