import { useEffect, useRef, type RefObject } from 'react';

/** Where a card of the queue is found, and the keys of its three buttons (the kit's ApprovalCard sets `data-key`). */
export const CARD_SELECTOR = '[data-task-id]';
const KEY_APPROVE = '[data-key="1"]';

/** A person typing: no key of the queue means anything there. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** Something modal or a menu is open: it owns the keyboard until it closes. */
function overlayOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null;
}

/** Puts the focus on a card by its Approve button, and brings the card into view. */
function focusCard(card: HTMLElement | undefined): void {
  if (card === undefined) return;
  card.querySelector<HTMLElement>(KEY_APPROVE)?.focus({ preventScroll: true });
  // A browser without layout (a test) has nothing to scroll
  if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' });
}

/** How long after a press the queue still takes the focus back for the card that moved up into its place. */
const REFOCUS_WINDOW_MS = 10_000;

/**
 * The keyboard of the approvals queue, in the manner of a triage list: J and K (and the arrow keys while a card holds
 * the focus) move between the plans; 1, E and H press that plan's Approve, Edit and Not now. The keys act only on the
 * card that holds the focus, so a stray key never decides a plan nobody was looking at. They do nothing while someone
 * types, while a dialog or menu is open, with a modifier held, or when a key is held down. When a plan leaves the
 * queue (approved, set aside) the focus goes to the plan that took its place instead of falling to the page.
 */
export function useQueueKeys(listRef: RefObject<HTMLElement | null>, taskIds: readonly string[]): void {
  // The place of the card the last press was made on, and when: its card may be gone by the time the list answers
  const lastPress = useRef<{ index: number; at: number } | null>(null);

  useEffect(() => {
    function cards(): HTMLElement[] {
      return Array.from(listRef.current?.querySelectorAll<HTMLElement>(CARD_SELECTOR) ?? []);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target) || overlayOpen()) return;
      const all = cards();
      if (all.length === 0) return;
      const at = all.findIndex((card) => card.contains(document.activeElement));
      const key = event.key.toLowerCase();

      const down = key === 'j' || (key === 'arrowdown' && at >= 0);
      const up = key === 'k' || (key === 'arrowup' && at >= 0);
      if (down || up) {
        event.preventDefault();
        const next = at < 0 ? (down ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, at + (down ? 1 : -1)));
        focusCard(all[next]);
        return;
      }

      const button = key === '1' ? '1' : key === 'e' ? 'E' : key === 'h' ? 'H' : null;
      if (button === null || at < 0 || event.repeat) return;
      const target = all[at]?.querySelector<HTMLElement>(`[data-key="${button}"]`);
      if (target === null || target === undefined) return;
      event.preventDefault();
      lastPress.current = { index: at, at: Date.now() };
      target.click();
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [listRef]);

  // A click on a card's button counts as a press too: the card may leave the queue under the pointer
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    function onClick(event: MouseEvent) {
      const all = Array.from(list?.querySelectorAll<HTMLElement>(CARD_SELECTOR) ?? []);
      const index = all.findIndex((card) => card.contains(event.target as Node));
      if (index >= 0) lastPress.current = { index, at: Date.now() };
    }
    list.addEventListener('click', onClick, true);
    return () => list.removeEventListener('click', onClick, true);
  }, [listRef, taskIds.length]);

  // The plan left the queue: give the focus to the one that moved up into its place
  const previous = useRef(taskIds);
  useEffect(() => {
    const before = previous.current;
    previous.current = taskIds;
    const press = lastPress.current;
    if (press === null || taskIds.length >= before.length) return;
    lastPress.current = null;
    if (Date.now() - press.at > REFOCUS_WINDOW_MS) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && listRef.current?.contains(active)) return;
    const all = Array.from(listRef.current?.querySelectorAll<HTMLElement>(CARD_SELECTOR) ?? []);
    focusCard(all[Math.min(press.index, all.length - 1)]);
  }, [taskIds, listRef]);
}
