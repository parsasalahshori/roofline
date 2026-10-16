import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { settings } from '../src/copy/settings.ts';
import { SettingsTabs } from '../src/features/settings/SettingsTabs.tsx';
import { renderAt } from './helpers.tsx';

afterEach(cleanup);

const strip = () => screen.getByRole('navigation', { name: settings.tabsLabel });

describe('settings tabs', () => {
  it('lists the tabs a role may open and marks the open one', () => {
    renderAt(<SettingsTabs current="schedule" role="owner" />);
    const links = within(strip()).getAllByRole('link');
    expect(links).toHaveLength(11);
    expect(within(strip()).getByRole('link', { name: settings.tabs.schedule })).toHaveAttribute('aria-current', 'page');
    expect(within(strip()).getByRole('link', { name: settings.tabs.company })).not.toHaveAttribute('aria-current');
    cleanup();

    // A field rep has no Prices, Storm, Front Desk or Agents
    renderAt(<SettingsTabs current="company" role="rep" />);
    expect(within(strip()).getAllByRole('link').map((link) => link.textContent)).toEqual([
      settings.tabs.company,
      settings.tabs.team,
      settings.tabs.schedule,
      settings.tabs.connections,
      settings.tabs.billing,
      settings.tabs.setup,
      settings.tabs.profile,
    ]);
  });

  it('fades the end of the row while more tabs wait past it, and the start once it has scrolled', () => {
    renderAt(<SettingsTabs current="company" role="owner" />);
    const nav = strip();
    const wrap = nav.parentElement;
    let left = 0;
    // jsdom has no layout: say how wide the row is, and how wide its tabs are
    Object.defineProperty(nav, 'scrollWidth', { configurable: true, value: 900 });
    Object.defineProperty(nav, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(nav, 'scrollLeft', {
      configurable: true,
      get: () => left,
      set: (next: number) => {
        left = next;
      },
    });

    fireEvent.scroll(nav);
    expect(wrap).toHaveAttribute('data-more-end', 'true');
    expect(wrap).not.toHaveAttribute('data-more-start');

    left = 300;
    fireEvent.scroll(nav);
    expect(wrap).toHaveAttribute('data-more-start', 'true');
    expect(wrap).toHaveAttribute('data-more-end', 'true');

    left = 600;
    fireEvent.scroll(nav);
    expect(wrap).toHaveAttribute('data-more-start', 'true');
    expect(wrap).not.toHaveAttribute('data-more-end');
  });
});
