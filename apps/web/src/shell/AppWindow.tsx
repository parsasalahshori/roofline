import { Window } from '@roofline/ui';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { common } from '../copy/common.ts';
import { WINDOW_COPY } from '../copy/dock.ts';
import { DOCK_APPS, type WindowKey } from './apps.ts';
import { useIsPhone } from './useIsPhone.ts';

/** The glyph colour on each app's tile, as the dock draws it; an app not listed uses the default tile ink. */
const TILE_INK: Partial<Record<WindowKey, string>> = {
  storm: 'var(--lift-tile-ink-accent)',
  agents: 'var(--lift-tile-ink-accent)',
  estimator: 'var(--lift-tile-ink-dark)',
};

/**
 * A window on the map: its title and line come from WINDOW_COPY, and closing it goes back to the map.
 * It is keyed by app, so opening another app replaces this one. On a phone it fills the screen.
 */
export function AppWindow({ app, children, stats }: { app: WindowKey; children: ReactNode; stats?: ReactNode }) {
  const navigate = useNavigate();
  const phone = useIsPhone();
  const copy = WINDOW_COPY[app];
  const dockApp = DOCK_APPS.find((a) => a.key === app);

  return (
    <Window
      key={app}
      title={copy.title}
      description={copy.description}
      stats={stats}
      icon={dockApp?.icon}
      iconBackground={dockApp ? `var(--lift-tile-${app})` : undefined}
      iconColor={dockApp ? (TILE_INK[app] ?? 'var(--lift-tile-ink)') : undefined}
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
