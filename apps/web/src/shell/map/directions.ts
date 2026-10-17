/** Where a maps app takes you: the address as the destination. A plain link, so a phone offers its own maps app. */
export function directionsUrl(address: string): string {
  return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(address);
}

/** The attributes of a link to another site that opens in a new tab. */
export const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' } as const;
