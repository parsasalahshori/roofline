import { EmptyState } from '@roofline/ui';
import { homeowner } from '../../copy/homeowner.ts';

/** The public homeowner page skeleton: no session and no shell, a line until it is built. */
export function HomeownerPage() {
  return (
    <main>
      <EmptyState title={homeowner.comingSoon} />
    </main>
  );
}
