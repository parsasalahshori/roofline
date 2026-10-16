/** The top bar, the user menu, and the page for an address that leads nowhere. */
export const shell = {
  needYourOk: (count: number) => `${count} need your OK`,
  agentsWorking: (working: number) =>
    working === 0 ? 'All quiet' : working === 1 ? '1 agent working' : `${working} agents working`,
  /** The date and time on the top bar: Fri, Sep 25, 1:31 PM. */
  dateTime: (date: Date) =>
    new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(
      date,
    ),

  /** The bell in the top bar: it opens the plans waiting for a yes. */
  notificationsLabel: "Notifications",

  // The user menu
  menuLabel: 'Account menu',
  myDay: 'My day',
  settings: 'Settings',
  switchTo: (companyName: string) => `Switch to ${companyName}`,
  signOut: 'Sign out',

  /** The breadcrumb of the Home page. */
  crumbHome: 'Home',
  /** The breadcrumb navigation's name (every page's trail in the top bar). */
  crumbsLabel: 'Breadcrumb',
  /** Back to the page above, on a phone. */
  back: (parent: string) => `Back to ${parent}`,
  /** The mark of a company with no logo, read out beside its name. */
  companyMark: (name: string) => `${name} logo`,

  // The window for an address that leads nowhere
  notFoundTitle: "This page isn't here",
  backHome: 'Back to Home',

  // The phone's bottom tabs and the More sheet
  tabsLabel: 'Main',
  tabMyDay: 'My day',
  tabMap: 'Map',
  tabMeasure: 'Measure',
  /** The count on the My day tab. */
  tabWaiting: (count: number) => (count === 1 ? '1 needs your OK' : `${count} need your OK`),
  tabJobs: 'Jobs',
  tabCalendar: 'Calendar',
  tabMore: 'More',
  moreTitle: 'More',
  moreClose: 'Close',
} as const;
