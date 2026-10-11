/** The search button and its dialog. */
export const search = {
  /** The top-bar button's name. */
  open: 'Search',
  dialogTitle: 'Search',
  inputLabel: 'Search customers, jobs and addresses',
  placeholder: 'Search customers, jobs and addresses',
  hint: 'Type at least 2 characters to search.',
  searching: 'Searching…',
  customers: 'Customers',
  jobs: 'Jobs',
  addresses: 'Addresses',
  listLabel: 'Search results',
  noMatches: (query: string) => `No matches for “${query}”`,
  /** Joins the pieces of a result's second line: stage, address, phone. Pieces that are missing are left out. */
  join: (parts: ReadonlyArray<string | null | undefined>) =>
    parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' · '),
} as const;
