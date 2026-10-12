/** The personal texts review kit: the preview under a send_personal_texts step and its Edit fields. */
export const stepTexts = {
  title: (n: number) => (n === 1 ? 'Send 1 personal text' : `Send ${n} personal texts`),
  /** The small label above each text; the number is its place in the list. */
  customerN: (i: number) => `Customer ${i}`,
  /** The Edit field label. */
  textTo: (i: number) => `Text to customer ${i}`,
  remove: 'Remove',
  showMore: (n: number) => `Show ${n} more`,
  lastOne: 'Keep at least one text, or turn this step off.',
  empty: 'Please write the text or remove it.',
  tooLong: 'Please keep each text to 480 characters or fewer.',
  missingStop: 'Review requests must end with “Reply STOP to opt out.”',
};
