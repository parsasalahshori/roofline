import type { BackofficeOrderRow, BackofficeQuoteWithJob } from '@roofline/db';
import {
  priceQuote,
  totalUnits,
  type BackofficeQuote,
  type BackofficeQuoteSummary,
  type ProductCatalog,
} from '@roofline/shared';

/**
 * The catalog a quote is priced with: its own snapshot once accepted (its prices never move), else the company's
 * current price book.
 */
export const catalogFor = (found: BackofficeQuoteWithJob, current: ProductCatalog): ProductCatalog => found.quote.catalogSnapshot ?? current;

/** The quote as GET/PUT answer it: stored drawings with every line, total and problem worked out now by the shared code. */
export function toQuoteView(found: BackofficeQuoteWithJob, current: ProductCatalog): BackofficeQuote {
  const { quote } = found;
  const catalog = catalogFor(found, current);
  const priced = priceQuote({ designs: quote.designs, accessories: quote.accessories, discountPercent: quote.discountPercent }, catalog);
  return {
    id: quote.id,
    jobId: quote.jobId,
    customerName: found.customerName,
    address: found.address,
    status: quote.status,
    tier: quote.tier,
    catalogVersion: quote.catalogVersion,
    designs: quote.designs,
    accessories: quote.accessories,
    discountPercent: quote.discountPercent,
    lines: priced.lines,
    totals: priced.totals,
    issues: priced.issues,
    discountNeedsApproval: priced.discountNeedsApproval,
    orderId: found.orderId,
    createdAt: quote.createdAt.toISOString(),
    updatedAt: quote.updatedAt.toISOString(),
  };
}

export function toQuoteSummary(found: BackofficeQuoteWithJob, current: ProductCatalog): BackofficeQuoteSummary {
  const { quote } = found;
  const priced = priceQuote({ designs: quote.designs, accessories: quote.accessories, discountPercent: quote.discountPercent }, catalogFor(found, current));
  return {
    id: quote.id,
    jobId: quote.jobId,
    customerName: found.customerName,
    address: found.address,
    status: quote.status,
    tier: quote.tier,
    units: totalUnits(quote.designs),
    totalCents: priced.totals[quote.tier].totalCents,
    orderId: found.orderId,
    updatedAt: quote.updatedAt.toISOString(),
  };
}

export type { BackofficeOrderRow };
