import { useEffect, useEffectEvent, type RefObject } from 'react';

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
 * Traps that are active right now, oldest first. Only the last one answers Tab and Esc, so a Sheet
 * opened over a Window gets the keys and the Window gets them back when the Sheet closes.
 */
const activeTraps: Array<{ container: HTMLElement }> = [];

function pushTrap(trap: { container: HTMLElement }) {
  // A trap that contains another one sits underneath it, however late it activated: when both mount in
  // the same render, the child's effect runs before the parent's, and the inner trap must still win.
  const inner = activeTraps.findIndex((other) => trap.container.contains(other.container));
  if (inner === -1) activeTraps.push(trap);
  else activeTraps.splice(inner, 0, trap);
}

function removeTrap(trap: { container: HTMLElement }) {
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
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  { active, onEscape, initialFocus }: FocusTrapOptions,
): void {
  // Read the latest values when a key is pressed or the trap starts, without restarting the trap.
  const handleEscape = useEffectEvent(() => onEscape?.());
  const startFocus = useEffectEvent(() => initialFocus?.current ?? ref.current);

  useEffect(() => {
    const container = ref.current;
    if (!active || !container) return;

    const trap = { container };
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pushTrap(trap);
    startFocus()?.focus();

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
      if (opener?.isConnected) opener.focus();
    };
  }, [active, ref]);
}
