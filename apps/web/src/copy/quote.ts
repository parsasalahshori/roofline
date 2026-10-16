import type { QuoteProduct } from '@roofline/shared';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Whole dollars from integer cents: 1425000 gives "$14,250". */
export const quoteMoney = (cents: number): string => dollars.format(cents / 100);

const PRODUCT_NAMES: Record<QuoteProduct, string> = {
  windows: 'Window Replacement',
  roof: 'Roof Replacement',
  gutters: 'Gutters',
};

/** The public instant quote page (/q/:slug) a company puts on its website. */
export const quote = {
  pageTitle: (company: string): string => `Instant estimate from ${company}`,
  loading: 'Loading',
  notFoundTitle: 'This page is not available',
  notFoundBody: 'The estimate page you opened is turned off or does not exist.',
  loadFailed: "We couldn't load this page. Please check your connection and try again.",
  retry: 'Try again',

  // Address step
  heading: 'Get your free estimate in seconds',
  intro: 'Enter your home address. We measure your home from above and show you a price range right away.',
  addressLabel: 'Home address',
  addressPlaceholder: '123 Main St, City, ST 12345',
  addressHelp: 'Street, city, state and ZIP.',
  addressRequired: 'Please enter the address of your home.',
  measureButton: 'See my estimate',
  noObligation: 'Free. No obligation.',

  // Measuring step (the scan)
  measuringTitle: 'Measuring your home',
  stages: {
    finding: 'Finding your home',
    tracing: 'Tracing the roof outline',
    reading: 'Counting walls and windows',
    pricing: 'Working out your price range',
  } as const,
  seconds: (s: number): string => `${s.toFixed(1)} s`,

  // Results
  resultsTitle: 'Your estimate',
  forAddress: (address: string): string => `For ${address}`,
  roofLine: (squares: number): string => `Roof: about ${squares.toLocaleString('en-US')} squares`,
  windowsLine: (count: number): string => `About ${count} ${count === 1 ? 'window' : 'windows'}`,
  guttersLine: (feet: number): string => `Gutters: about ${feet.toLocaleString('en-US')} ft`,
  guttersNoRange: 'Gutters: priced at your free visit',
  range: (low: number, high: number): string => `from ${quoteMoney(low)} to ${quoteMoney(high)}`,
  finalNote: 'Final price after a free in-home visit.',
  pickProducts: 'What would you like a price for?',
  productName: (p: QuoteProduct): string => PRODUCT_NAMES[p],
  continueButton: 'Get my exact price',
  outlineAlt: 'Satellite photo of your home with the measured roof outline',
  imagery: 'Imagery: Esri, Maxar, Earthstar Geographics',
  startOver: 'Use a different address',

  // Fallback (daily limit reached, or the home could not be measured)
  fallbackTitle: "We'll call you with your estimate",
  fallbackBody: 'We could not measure this home online right now. Leave your details and we will call you with a price, usually the same day.',

  // Lead form
  formTitle: 'Where should we send your estimate?',
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phone: 'Phone',
  postalCode: 'ZIP code',
  products: 'Services',
  consentLabel: 'I agree to be contacted',
  slotsTitle: 'Pick a time for your free in-home visit (optional)',
  slotsNone: 'No times are open online right now. We will call you to set one up.',
  slotsLoading: 'Loading open times',
  slotNone: 'Call me to set a time',
  submit: 'Get my estimate',
  sending: 'Sending',
  honeypotLabel: 'Leave this field empty',

  // Validation (in the browser; the server says the same things)
  required: (label: string): string => `Please enter your ${label.toLowerCase()}.`,
  phoneInvalid: "That doesn't look like a US phone number.",
  emailInvalid: 'Please enter a valid email address.',
  zipInvalid: 'Please enter a 5-digit ZIP code.',
  productsRequired: 'Pick at least one service.',
  consentRequired: 'Please check the box to agree to be contacted.',
  genericError: 'Something went wrong. Please try again.',
  tooFast: "You're going a little fast. Try again in a minute.",

  // Done
  doneTitle: (first: string): string => `Thanks, ${first}!`,
  doneBody: 'We have your request. Someone from our team will contact you shortly to confirm your free in-home visit.',
  doneBooked: (when: string): string => `Your free in-home visit is booked for ${when}.`,
  doneCall: (phone: string): string => `Questions? Call us at ${phone}.`,
} as const;

/** The owner's Settings section for the page (Settings -> Prices -> Instant quote page). */
export const quoteSettings = {
  title: 'Instant quote page',
  intro: 'Put an instant estimate on your website in place of your "free estimate" form. Homeowners see a price range, never your exact prices, and their details come in as new leads.',
  enabled: 'Turn on the instant quote page',
  slug: 'Page address',
  slugHelp: (origin: string): string => `${origin}/q/your-name`,
  products: 'Services on the page',
  rangePct: 'Range width (percent each side)',
  rangeHelp: 'A 12 % width shows a $10,000 job as about $8,800 to $11,200, rounded out to hundreds.',
  dailyCap: 'Online measurements a day',
  dailyCapHelp: 'Each new address costs map fees. Past this number the page offers a call back and still takes the request. Repeat addresses within 30 days are free.',
  embedOrigins: 'Websites allowed to embed the page',
  embedOriginsHelp: 'One per line, like https://www.yoursite.com',
  booking: 'Let homeowners pick an in-home visit time',
  accentColor: 'Button colour',
  accentHelp: 'A colour like #1f6feb. Leave empty for the default.',
  save: 'Save',
  saved: 'Saved',
  officeReadOnly: 'Only the owner can change these settings.',
  embedTitle: 'Add it to your website',
  embedHelp: 'Paste this where your estimate form is now. The box grows to fit the page.',
  copy: 'Copy code',
  copied: 'Copied',
  preview: 'Preview the page',
  turnOnFirst: 'Turn the page on and save to get the code.',
  iframeTitle: 'Instant estimate',
} as const;
