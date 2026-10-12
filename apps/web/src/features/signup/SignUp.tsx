import { EmptyState } from '@roofline/ui';
import { auth } from '../../copy/auth.ts';

/** The public sign-up page. A placeholder until the sign-up screen is built. */
export function SignUp() {
  return <EmptyState title={auth.comingSoon} />;
}
