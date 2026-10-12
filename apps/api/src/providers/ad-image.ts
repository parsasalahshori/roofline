/** Renders a 1080x1080 PNG ad card. */
export interface AdImageRenderer { card(i: { companyName: string; line: string; colorHex: string }): Promise<Uint8Array> }
