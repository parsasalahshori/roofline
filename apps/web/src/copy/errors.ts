/** What a person reads when the server gave no words of its own. */
export const errors = {
  generic: 'Something went wrong. Please try again.',
  tryAgain: 'Try again',
  /** The heading of the page that replaces a screen when its route fails. */
  pageTitle: 'Something went wrong on this page.',
  /** The line under that heading. */
  pageBody: 'Your work is safe. Reload to try again.',
  /** The button that reloads the page. */
  reload: 'Reload',
} as const;
