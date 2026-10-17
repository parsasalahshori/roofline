import { SATELLITE_UNUSABLE_MESSAGE, type QuoteProduct } from '@roofline/shared';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** "in-home" with a word joiner (U+2060, invisible) after the hyphen, so a narrow line never breaks it into "in-" and "home". */
const inHome = 'in-\u2060home';

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

  // Service picker (the first step)
  servicesTitle: 'What are you looking for?',
  servicesIntro: 'Pick one or more.',
  servicesHint: {
    windows: 'How many windows your home has, counted from above. Measure them for the exact price.',
    roof: 'Measured from above. A price range in seconds.',
    gutters: 'Priced at your free visit.', // staff-only service: never offered on the page
  } as Record<QuoteProduct, string>,
  servicesContinue: 'Continue',
  servicesLooking: (names: string): string => `Looking for: ${names}`,
  servicesChange: 'Change',

  // Address step
  heading: 'Get your free estimate in seconds',
  intro: 'Enter your home address. We measure your home from above and show you your estimate right away.',
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
  roofLine: (squares: number): string => `About ${squares.toLocaleString('en-US')} squares`,
  windowsLine: (count: number, range?: { low: number; high: number }): string => {
    const base = `About ${count} ${count === 1 ? 'window' : 'windows'}`;
    return range !== undefined && (range.low !== count || range.high !== count) ? `${base} (${range.low}\u2013${range.high})` : base;
  },
  windowsEstimate: 'Counted from above, so it may be a little off.',
  range: (low: number, high: number): string => `from ${quoteMoney(low)} to ${quoteMoney(high)}`,
  finalNote: `Final price after a free ${inHome} visit.`,
  pickProducts: 'What would you like a price for?',
  productName: (p: QuoteProduct): string => PRODUCT_NAMES[p],
  /** The estimate's next step is the request form, so the button says that: the exact price only comes after the visit. */
  continueButton: 'Next: your details',
  nothingShown: 'We need a closer look to give a fair price for this. Leave your details and we will call you.',
  visitLink: "Book a free visit and we'll measure",

  // Measuring the windows (only where the company has the app): the app on an iPhone, the browser on Android, a QR code on a computer
  appDownload: (app: string): string => `Download the ${app} app to measure your windows`,
  appLine: 'The app measures each window and gives you the exact price.',
  browserMeasure: 'Measure your windows in your browser',
  browserLine: 'Use your phone\'s camera to measure each window and get the exact price.',
  qrCaption: 'Scan with your phone: iPhone opens the app, Android measures in the browser',
  browserSoonTitle: 'Measuring in your browser is coming soon',
  browserSoonBody: 'For now, book a free visit and we will measure your windows for you.',
  browserSoonBack: 'Back to my estimate',
  appQrAlt: (app: string): string => `QR code that opens the ${app} app`,
  outlineAlt: 'Satellite photo of your home with the measured roof outline',
  imagery: 'Imagery: Esri, Maxar, Earthstar Geographics',
  startOver: 'Use a different address',

  // Fallback (daily limit reached, or a home we would rather price after a look: a flat, a big building, a roof hard to see)
  fallbackTitle: "We'll call you with your estimate",
  fallbackLead: 'Some homes need a person to look before we can give a fair price, and this is one of them.',
  fallbackBody: 'Leave your details and we will call you with your estimate, usually within one business day.',

  // The satellite pictures cannot be trusted for the roof (too old or not sharp enough): no roof price, a free visit instead
  satelliteTitle: "We'll measure your roof at a free visit",
  satelliteBody: SATELLITE_UNUSABLE_MESSAGE,

  // Lead form
  formTitle: 'How can we reach you?',
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phone: 'Phone',
  postalCode: 'ZIP code',
  products: 'Services',
  consentLabel: 'You may call or email me about my estimate',
  textConsentLabel: 'You may also text me (optional)',
  privacyLink: 'Privacy Policy',
  termsLink: 'Terms',
  slotsTitle: `Pick a time for your free ${inHome} visit (optional)`,
  slotsNone: 'No times are open online right now. We will call you to set one up.',
  slotsLoading: 'Loading open times',
  slotNone: 'Call me to set a time',
  submit: 'Send my request',
  sending: 'Sending',
  honeypotLabel: 'Leave this field empty',

  // Validation (in the browser; the server says the same things)
  required: (label: string): string => `Please enter your ${label.toLowerCase()}.`,
  phoneInvalid: "That doesn't look like a US phone number.",
  emailInvalid: 'Please enter a valid email address.',
  zipInvalid: 'Please enter a 5-digit ZIP code.',
  productsRequired: 'Pick at least one service.',
  consentRequired: 'Please check the box so we can call or email you.',
  genericError: 'Something went wrong. Please try again.',
  tooFast: "That's a lot of tries from this connection. Please try again in an hour, or give us a call.",

  // Done
  doneTitle: (first: string): string => `Thanks, ${first}!`,
  doneBody: `We have your request. Someone from our team will contact you shortly to confirm your free ${inHome} visit.`,
  doneBooked: (when: string): string => `Your free ${inHome} visit is booked for ${when}.`,
  doneBodyBooked: 'We have your request and your visit time. If you need to change it, just give us a call.',
  doneSlotTaken: 'The time you picked was just taken, so we will call you to set another one.',
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
  dailyCapHelp: 'Each new address costs map fees. Past this number of priced estimates the page offers a call back and still takes the request. Repeat addresses within 30 days are free.',
  embedOrigins: 'Websites allowed to embed the page',
  embedOriginsHelp: 'One per line, like https://www.yoursite.com',
  booking: 'Let homeowners pick an in-home visit time',
  bookingHelp:
    'Times start tomorrow. A booked visit goes to any inspector who is free then, wherever they work: there is no matching by area yet. Leave this off if your inspectors cover different areas.',
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
