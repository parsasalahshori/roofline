import { createContext, type ReactNode } from 'react';

/**
 * What the shell hands every Page. On a desktop, two places in the top bar a page can put things into: the
 * breadcrumb at the left and its own controls at the right (the Measure switch); Page portals into them. On a phone
 * there is no top bar: `phone` is true, a nested page draws its own way back, and a top-level page shows the shell's
 * `trailing` controls (search, the bell, the person) at the right of its title. Without a shell (a test, a page
 * rendered alone) there are no slots and Page draws the breadcrumb inline.
 */
export type PageSlots = {
  crumbs: HTMLElement | null;
  actions: HTMLElement | null;
  phone: boolean;
  trailing: ReactNode;
};

export const PageSlotsContext = createContext<PageSlots>({ crumbs: null, actions: null, phone: false, trailing: null });
