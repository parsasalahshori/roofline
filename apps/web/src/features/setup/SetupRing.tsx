import { Button, ProgressRing } from '@roofline/ui';
import { setup } from '../../copy/setup.ts';
import { useSetup } from './api.ts';

/*
 * The setup progress ring beside the avatar in the user menu. It links to the Setup tab and is hidden
 * while the progress is unknown (loading or failed) and once every step is done.
 */
export function SetupRing() {
  const { data } = useSetup();
  if (!data) return null;

  const { done, total } = data.progress;
  if (done >= total) return null;

  const label = setup.ringLabel(done, total);
  return (
    <Button variant="ghost" href="/settings/setup" aria-label={label}>
      <ProgressRing done={done} total={total} label={label} size={24} />
    </Button>
  );
}
