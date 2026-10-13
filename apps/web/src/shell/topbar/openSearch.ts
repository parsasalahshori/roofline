/** The event the dock's search button sends; the search dialog in the top bar listens for it and opens. */
export const OPEN_SEARCH_EVENT = 'roofline:open-search';

export function requestSearch(): void {
  window.dispatchEvent(new Event(OPEN_SEARCH_EVENT));
}
