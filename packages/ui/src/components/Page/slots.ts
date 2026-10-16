import { createContext } from 'react';

/**
 * Two places in the top bar a page can put things into: the breadcrumb at the left and its own controls at the
 * right (the Measure switch). The shell owns the bar and hands the elements down; Page portals into them.
 * Without a shell (a test, a page rendered alone) both are null and Page draws the breadcrumb inline.
 */
export type PageSlots = { crumbs: HTMLElement | null; actions: HTMLElement | null };

export const PageSlotsContext = createContext<PageSlots>({ crumbs: null, actions: null });
