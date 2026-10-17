const NBSP = ' ';

/**
 * A house number stays with its street when a line breaks: "5411 W 12th St" and "305 Ridgeway Dr" do not come apart after
 * the number (or after the direction). The feed, waiting and task sentences are plain text from the server, so the
 * joining is done here, where they are drawn. Words that are not capitalised after a number ("13 customers") are left alone.
 */
export function keepAddressTogether(text: string): string {
  return text
    .replace(/\b(\d{1,6}) ([NSEW]) (?=[A-Za-z0-9])/g, `$1${NBSP}$2${NBSP}`)
    .replace(/\b(\d{1,6}) (?=[A-Z][a-z])/g, `$1${NBSP}`);
}
