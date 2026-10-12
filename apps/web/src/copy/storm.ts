/** The Storm window. Never name a vendor here: the ad accounts are named in copy/connections.ts. */
export const storm = {
  /** The name of the card that offers the newest storm plan. */
  planHeading: 'A storm plan is ready for you',
  approve: 'Approve storm plan',
  /** The storm page, until the storm detail is built. */
  detailComingSoon: 'This storm is on its way.',
  /** The Storm tab in Settings (owner and office). */
  settings: {
    loading: 'Loading your storm settings',
    save: 'Save',
    saved: 'Storm settings saved.',

    thresholdHeading: 'When a storm starts a plan',
    thresholdLabel: 'Hail size that starts a plan',
    thresholdHelp: 'Radar-estimated hail at or above this size starts a storm plan.',
    thresholdOption: (inches: number) => `${inches.toFixed(2)} inches`,

    budgetHeading: 'Ad budget for a storm',
    budgetLabel: 'Budget in dollars',
    budgetHelp: 'The most the ads may spend for one storm.',
    budgetInvalid: 'Please enter the budget as a dollar amount, such as 300.',
    daysLabel: 'Days the ads run',
    daysHelp: 'Whole days, from 1 to 30.',
    daysInvalid: 'Please enter the days as a whole number.',
    shareHelp: 'Drag to split the budget between the two ad accounts.',

    emailsHeading: 'Storm emails',
    emailsLabel: 'Send storm emails',
    emailsHelp: 'Turn this off to stop storm emails for this company.',

    templatesHeading: 'Storm messages',
    templatesHelp: 'The texts and emails sent after a storm. Each one fills in with the person it goes to.',
    tokensHelp: 'Words that fill in: {first_name}, {company}, {hail_size}, {street}, {day}, {company_address}, {unsubscribe}.',
    smsLabel: 'Text message',
    smsHelp: 'Keep {company} and Reply STOP so people can opt out.',
    emailSubjectLabel: 'Email subject',
    emailLabel: 'Email message',
    emailHelp: 'Keep {company}, {company_address} and {unsubscribe} so people can unsubscribe.',
    useStandardText: 'Use the standard text',
    useStandardTextFor: (name: string) => `Use the standard text for ${name}`,
    missingTokens: (list: string) => `This message is missing ${list}. Add it before you save.`,

    photosHeading: 'Ad photos',
    photosHelp: 'JPEG or PNG, up to 5 MB each. Shown with the storm ads.',
    photosEmpty: 'No photos yet.',
    photosFull: (max: number) => `You have the most photos allowed, ${max}. Remove one to add another.`,
    photoPickLabel: 'Add a photo',
    photoChoose: 'Choose a photo',
    photoDrop: 'Or drop a photo here',
    photoType: 'Photos must be a JPEG or PNG.',
    photoSize: 'Photos must be 5 MB or smaller.',
    photoAlt: (n: number) => `Ad photo ${n}`,
    removePhoto: (n: number) => `Remove ad photo ${n}`,
    remove: 'Remove',
  },
} as const;
