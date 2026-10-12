export interface LineLookup { lineType(e164: string): Promise<'mobile' | 'landline' | 'voip' | 'unknown'> }
