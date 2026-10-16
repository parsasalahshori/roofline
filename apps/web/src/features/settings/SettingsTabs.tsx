import type { Role } from '@roofline/shared';
import { Tabs } from '@roofline/ui';
import { useEffect, useRef, useState } from 'react';
import { settings } from '../../copy/settings.ts';
import styles from './SettingsTabs.module.css';
import { type SettingsTab, visibleTabs } from './tabs.ts';

/** How far from an end the strip may be and still count as being at it, in pixels. */
const EDGE = 4;

/**
 * The row of tabs under the Settings title. Eleven tabs are wider than a phone, so the strip scrolls sideways; a fade
 * at an edge says there is more past it, and the open tab is brought into view when the page opens.
 */
export function SettingsTabs({ current, role }: { current: SettingsTab; role: Role | undefined }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ start: false, end: false });

  useEffect(() => {
    const strip = wrap.current?.querySelector('nav');
    if (!strip) return;

    const measure = () => {
      const start = strip.scrollLeft > EDGE;
      const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - EDGE;
      setMore((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
    };

    // Centre the open tab in the strip, so a tab at the far end is not hidden on a phone
    const open = strip.querySelector<HTMLElement>('[aria-current="page"]');
    if (open) {
      const tab = open.getBoundingClientRect();
      const box = strip.getBoundingClientRect();
      strip.scrollLeft += tab.left - box.left - (box.width - tab.width) / 2;
    }
    measure();

    strip.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      strip.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [current, role]);

  return (
    <div ref={wrap} className={styles.strip} data-more-start={more.start || undefined} data-more-end={more.end || undefined}>
      <Tabs
        label={settings.tabsLabel}
        items={visibleTabs(role).map((key) => ({ key, label: settings.tabs[key], href: '/settings/' + key, current: key === current }))}
      />
    </div>
  );
}
