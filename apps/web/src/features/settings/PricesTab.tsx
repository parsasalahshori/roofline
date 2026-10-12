import { EmptyState } from '@roofline/ui';
import { prices } from '../../copy/prices.ts';
import { EstimateSection } from './EstimateSection.tsx';
import { FinancingSection } from './FinancingSection.tsx';
import { TiersSection } from './TiersSection.tsx';

/** The Prices settings tab. Task 18 skeleton: one line until the price list lands. */
export function PricesTab() {
  return (
    <>
      <EmptyState title={prices.comingSoon} />
      {/* E1 Task 14: Estimator sections, kept apart from C1's content above */}
      <TiersSection />
      <FinancingSection />
      <EstimateSection />
    </>
  );
}
