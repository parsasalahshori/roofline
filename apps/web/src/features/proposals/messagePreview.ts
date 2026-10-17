/** One piece of a text message as the customer reads it: words, or the place where the proposal's link goes. */
export type MessagePart = { link: false; text: string } | { link: true };

/** What the words that fill in are filled with. A blank first name says "there", as the text does when it goes out. */
export type MessageWords = { firstName: string | null; company: string; address: string };

const TOKEN = /\{(first_name|company|address|link)\}/g;

/**
 * The proposal's text message with its four words that fill in ({first_name}, {company}, {address}, {link}) filled for
 * this proposal, in one pass as the server does at send time, so a value is never read again as a word. The link is made
 * when the text goes out, so it comes back as its own part for the screen to show as a quiet "link to your proposal".
 * Any other {word}, and one with nothing to fill it, is left as written. The space that followed the link is dropped: the screen puts a break there.
 */
export function messageParts(template: string, words: MessageWords): MessagePart[] {
  const first = (words.firstName ?? '').trim();
  const values: Record<string, string> = { first_name: first === '' ? 'there' : first, company: words.company, address: words.address };
  const parts: MessagePart[] = [];
  let text = '';
  let last = 0;
  let afterLink = false;
  const flush = () => {
    const out = afterLink ? text.replace(/^ /, '') : text;
    if (out !== '') parts.push({ link: false, text: out });
    text = '';
  };
  for (const match of template.matchAll(TOKEN)) {
    const token = match[1] ?? '';
    text += template.slice(last, match.index);
    last = (match.index ?? 0) + match[0].length;
    if (token === 'link') {
      flush();
      parts.push({ link: true });
      afterLink = true;
    } else {
      // A word with nothing to fill it (the company's name not loaded yet) stays as written
      const value = values[token];
      text += value !== undefined && value !== '' ? value : match[0];
    }
  }
  text += template.slice(last);
  flush();
  return parts;
}
