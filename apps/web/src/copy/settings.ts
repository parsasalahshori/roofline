import type { Role } from '@roofline/shared';
import type { SettingsTab } from '../features/settings/tabs.ts';

/*
 * The Settings window (Task 16): its tabs, the Company tab and the Team tab. The Prices and Schedule tabs
 * are labelled here; their words are in prices.ts and schedule.ts. The words for Connections, Billing and
 * Setup are in connections.ts, billing.ts and setup.ts, where vendor names are allowed.
 */
export const settings = {
  // The row of links under the window title
  tabsLabel: 'Settings sections',
  tabs: {
    company: 'Company',
    team: 'Team',
    prices: 'Prices',
    schedule: 'Schedule',
    connections: 'Connections',
    storm: 'Storm',
    billing: 'Billing',
    setup: 'Setup',
    'front-desk': 'Front Desk',
    agents: 'Agents',
    profile: 'Your profile',
  } satisfies Record<SettingsTab, string>,

  // While a tab's information loads
  loading: 'Loading…',

  // The way back from a screen under Setup, and the bar that waits at the foot of a form while it has changes
  subpages: { import: 'Import customers', texting: 'Texting registration' },
  saveBar: {
    label: 'Unsaved changes',
    unsaved: 'You have unsaved changes',
    discard: 'Discard',
  },

  // Who a person is on the team. Passed to the role Selects and shown as text to people who cannot change them.
  roles: {
    owner: 'Owner',
    office: 'Office',
    rep: 'Field rep',
  } satisfies Record<Role, string>,

  company: {
    panels: { details: 'Company details', rate: 'Time saved' },
    fields: {
      name: 'Company name',
      phone: 'Phone',
      email: 'Email',
      website: 'Website',
      street: 'Street',
      city: 'City',
      state: 'State',
      zip: 'ZIP code',
      timezone: 'Time zone',
    },
    ownerOnly: 'Only the owner can change company details.',
    save: 'Save',
    saved: 'Saved',
    /** The owner-only rate the Agents screen uses to turn time saved into money */
    hourlyRate: {
      label: 'Hourly rate for time saved',
      hint: 'In dollars an hour, from $0 to $1,000. The Agents screen uses it to turn time saved into money.',
      error: 'Please enter an hourly rate between $0 and $1,000.',
      saved: 'Saved',
      save: 'Save hourly rate',
      loadError: 'We could not load the hourly rate. Try again in a moment.',
    },
    /** The US time zones, in the order of the list. `value` is the zone's name as the server stores it. */
    timeZones: [
      { value: 'America/New_York', label: 'Eastern Time (New York)' },
      { value: 'America/Chicago', label: 'Central Time (Chicago)' },
      { value: 'America/Denver', label: 'Mountain Time (Denver)' },
      { value: 'America/Phoenix', label: 'Arizona (Phoenix)' },
      { value: 'America/Los_Angeles', label: 'Pacific Time (Los Angeles)' },
      { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
      { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
      { value: 'America/Indiana/Indianapolis', label: 'Eastern Time (Indianapolis)' },
      { value: 'America/Kentucky/Louisville', label: 'Eastern Time (Louisville)' },
      { value: 'America/Detroit', label: 'Eastern Time (Detroit)' },
      { value: 'America/Boise', label: 'Mountain Time (Boise)' },
    ],
  },

  /** The few words of the Storm tab that are not in storm.ts: a hail size in a list, and the photo drop box. */
  stormTab: {
    /** "1 in", "1.25 in": the size as a number without trailing zeros. */
    hailSize: (inches: number) => `${inches} in`,
    photoDrop: 'Drop a photo here',
  },

  team: {
    heading: 'Team',
    /** The tag beside the name of the person who is signed in. */
    you: 'You',
    /** Beside the heading: how many people are on the team. */
    count: (people: number) => (people === 1 ? '1 person' : `${people} people`),
    tableLabel: 'Team members',
    columns: {
      name: 'Name',
      email: 'Email',
      role: 'Role',
      spend: 'Can approve spending',
      stormAlerts: 'Storm alerts',
      status: 'Status',
    },
    /** The accessible names of the controls in a member's row (the row's own words are the column titles). */
    roleFor: (name: string) => `Role for ${name}`,
    spendFor: (name: string) => `Can approve spending: ${name}`,
    /** The storm alerts switch: office members and owners get storm emails, field reps never do. */
    stormAlertsFor: (name: string) => `Storm alerts: ${name}`,
    turnOffFor: (name: string) => `Turn off ${name}`,
    turnBackOnFor: (name: string) => `Turn back on ${name}`,
    // The spending cell of an owner (always may) and of a field rep (never may); only office members get a switch
    spendAlways: 'Always',
    spendNever: 'Never',
    stormAlertsNever: 'Never',
    statusActive: 'Active',
    statusOff: 'Turned off',
    turnOff: 'Turn off',
    turnBackOn: 'Turn back on',

    inviteHeading: 'Invite a teammate',
    inviteEmail: 'Their email',
    inviteRole: 'Their role',
    sendInvite: 'Send invite',
    inviteSent: (email: string) => `Invite sent to ${email}`,

    pendingHeading: 'Waiting to join',
    pendingTableLabel: 'Invites waiting to be accepted',
    /** The heads of the invites table: who was invited, as what, and when the invite stops working. */
    pendingColumns: { email: 'Invited', role: 'Role', expires: 'Expires' },
    /** `date` is already written out, like Oct 18, 2026. */
    pendingExpires: (date: string) => `Invite expires ${date}`,
  },
} as const;
