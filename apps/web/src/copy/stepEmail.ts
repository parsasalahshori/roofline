/** The storm email review kit: the preview under a send_email_batch step and its Edit fields. */
export const stepEmail = {
  subjectLabel: 'Subject',
  bodyLabel: 'Message',
  tokensHelp: 'Keep {company}, {company_address} and {unsubscribe} in the message.',
  /** Above the per-customer sample: what one customer reads. */
  sampleLabel: 'What each customer reads',
  /** Under the sample label: the hail sizes in it are estimates. */
  hailCaption: 'Radar-estimated hail sizes',
  recipientsLine: (n: number) => (n === 1 ? '1 customer gets this email' : `${n} customers get this email`),
  /** One sentence per missing token, under the message field. */
  missingToken: (t: string) => `This email is missing ${t}. It will not be sent without it.`,
};
