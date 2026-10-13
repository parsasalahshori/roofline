import { Window } from '@roofline/ui';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { common } from '../copy/common.ts';
import { WINDOW_COPY } from '../copy/dock.ts';
import type { WindowKey } from './apps.ts';
import { useIsPhone } from './useIsPhone.ts';

/**
 * A window on the map: its title and line come from WINDOW_COPY, and closing it goes back to the map.
 * It is keyed by app, so opening another app replaces this one. On a phone it fills the screen.
 */
export function AppWindow({ app, children, stats, bare }: { app: WindowKey; children: ReactNode; stats?: ReactNode; bare?: boolean }) {
  const navigate = useNavigate();
  const phone = useIsPhone();
  const copy = WINDOW_COPY[app];

  return (
    <Window
      key={app}
      title={copy.title}
      description={copy.description}
      stats={stats}
      bare={bare}
      variant={phone ? 'page' : 'floating'}
      onClose={() => {
        void navigate('/');
      }}
      closeLabel={common.close}
    >
      {children}
    </Window>
  );
}
