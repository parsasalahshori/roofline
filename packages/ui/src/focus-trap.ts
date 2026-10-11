import { createContext, useContext, useEffect, useEffectEvent, useState, type RefObject } from 'react';

export type FocusTrapOptions = {
  /** The trap works while true. Turning it off (or unmounting) gives focus back. */
  active: boolean;
  /** Called on Esc. */
  onEscape?: () => void;
  /** Where focus lands when the trap starts. The container itself (tabIndex -1) when left out. */
  initialFocus?: RefObject<HTMLElement | null>;
};

const TABBABLE =
  'a[href], button, input, select, textarea, [tabindex], [contenteditable]:not([contenteditable="false"])';

/**
 * A trap's place in the React tree: who it was rendered under. It is made on the trap's first render,
 * so a parent and a child can be told apart before either one's effect has run. A component that holds
 * other traps in its children (Window, Sheet) passes its scope down with TrapScopeContext. React
 * context, not the DOM, because a Sheet is portaled to the body and is not inside its Window's markup.
 */
export type TrapScope = { parent: TrapScope | null };

export const TrapScopeContext = createContext<TrapScope | null>(null);

type ActiveTrap = {
  scope: TrapScope;
  container: HTMLElement;
  /** Where focus goes back to when the trap ends. Null once an outer trap has taken over (see `outer`). */
  opener: HTMLElement | null;
  /** A trap that mounted with this one and sits under it: it holds the real opener, this one hands focus to it. */
  outer?: ActiveTrap;
};

/** Traps that are active right now, in order of activation. Only the last one answers Tab and Esc. */
const activeTraps: ActiveTrap[] = [];

/** Is `ancestor` somewhere above `scope` in the React tree? */
function isAncestor(ancestor: TrapScope, scope: TrapScope): boolean {
  for (let node = scope.parent; node; node = node.parent) {
    if (node === ancestor) return true;
  }
  return false;
}

function removeTrap(trap: ActiveTrap) {
  const index = activeTraps.indexOf(trap);
  if (index !== -1) activeTraps.splice(index, 1);
}

/**
 * Can the element be reached with Tab? Layout is not consulted (jsdom has none): the element must not
 * be disabled, sit under something hidden, inert or aria-hidden, be taken out of the order with a
 * negative tabindex, or be switched off with display: none or visibility: hidden.
 */
function isTabbable(element: HTMLElement, container: HTMLElement): boolean {
  if (element.matches(':disabled')) return false;
  if (element instanceof HTMLInputElement && element.type === 'hidden') return false;
  const tabindex = element.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) < 0) return false;
  if (getComputedStyle(element).visibility === 'hidden') return false;

  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    if (getComputedStyle(node).display === 'none') return false;
    if (node === container) break;
  }
  return true;
}

function tabbableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE)).filter((element) =>
    isTabbable(element, container),
  );
}

/** Keeps Tab inside the container: from the last control forward, or the first backward, focus wraps around. */
function keepTabInside(event: KeyboardEvent, container: HTMLElement) {
  const items = tabbableIn(container);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    // Nothing to tab to: stay on the container
    event.preventDefault();
    container.focus();
    return;
  }

  const active = document.activeElement;
  const toward = event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  const wrapTo = event.shiftKey ? last : first;

  if (!active || !container.contains(active)) {
    // Focus is outside (a click on the page behind the window): bring it back in
    event.preventDefault();
    wrapTo.focus();
    return;
  }
  // Wrap when nothing tabbable lies ahead of the focused element in the direction of travel. This
  // also covers focus on a tabindex -1 element inside, and on the container itself going backward.
  if (!items.some((item) => active.compareDocumentPosition(item) & toward)) {
    event.preventDefault();
    wrapTo.focus();
  }
}

/**
 * Keeps keyboard focus inside `ref` while `active`: Tab and Shift+Tab cycle through its tabbable
 * elements and Esc calls `onEscape`. On activation the focused element is remembered and focus moves
 * to `initialFocus`, else the container; on deactivation or unmount focus goes back to the remembered
 * element if it is still on the page.
 *
 * Mouse clicks outside are not blocked and nothing outside is made inert: the dock stays clickable
 * while a window is open.
 *
 * Active traps form a stack and only the newest answers Tab and Esc, so a Sheet opened over a Window
 * gets the keys and the Window gets them back when the Sheet closes. A trap that is a React ancestor of
 * one already active (they mounted in the same render, and a child's effect runs before its parent's)
 * goes underneath it, keeps the focus where the inner one put it, and takes over its opener, so
 * the outer trap is the one that gives focus back to the real opener.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, options: FocusTrapOptions): void {
  useScopedFocusTrap(ref, options);
}

/**
 * useFocusTrap that also returns the trap's scope. A component that renders other traps inside
 * itself wraps what it renders in `<TrapScopeContext value={scope}>`, so they know they are nested.
 */
export function useScopedFocusTrap(
  ref: RefObject<HTMLElement | null>,
  { active, onEscape, initialFocus }: FocusTrapOptions,
): TrapScope {
  const parent = useContext(TrapScopeContext);
  const [scope] = useState<TrapScope>(() => ({ parent }));
  // Read the latest values when a key is pressed or the trap starts, without restarting the trap.
  const handleEscape = useEffectEvent(() => onEscape?.());
  const startFocus = useEffectEvent(() => initialFocus?.current ?? ref.current);

  useEffect(() => {
    const container = ref.current;
    if (!active || !container) return;

    const trap: ActiveTrap = {
      scope,
      container,
      opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    const inner = activeTraps.find((other) => isAncestor(scope, other.scope));
    if (inner) {
      // Mounted together with a trap inside it, which already holds the focus. Go underneath it and take
      // over its opener (the real one). The inner trap now gives focus back to this container, for as
      // long as this trap is active.
      trap.opener = inner.opener;
      inner.opener = null;
      inner.outer = trap;
      activeTraps.splice(activeTraps.indexOf(inner), 0, trap);
    } else {
      activeTraps.push(trap);
      startFocus()?.focus();
    }

    function onKeyDown(event: KeyboardEvent) {
      // Not the newest trap, already handled by something inside, or an IME is using the key
      if (activeTraps[activeTraps.length - 1] !== trap || event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        handleEscape();
      } else if (event.key === 'Tab') {
        keepTabInside(event, trap.container);
      }
    }
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      removeTrap(trap);
      // An inner trap hands focus to the trap under it, unless that one has ended first: it has then
      // already given focus back to the real opener, and this trap must not take it away again.
      const target = trap.outer ? (activeTraps.includes(trap.outer) ? trap.outer.container : null) : trap.opener;
      if (target?.isConnected) target.focus();
    };
  }, [active, ref, scope]);

  return scope;
}
