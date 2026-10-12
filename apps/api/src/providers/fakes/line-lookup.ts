import type { LineLookup } from '../line-lookup.ts';

export class FakeLineLookup implements LineLookup {
  lookups: string[] = [];

  async lineType(e164: string): Promise<'mobile' | 'landline' | 'voip' | 'unknown'> {
    this.lookups.push(e164);
    if (e164.startsWith('+1555')) return 'mobile';
    if (e164.startsWith('+1556')) return 'landline';
    if (e164.startsWith('+1557')) return 'voip';
    return 'unknown';
  }
}
