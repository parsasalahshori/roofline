import type { ConsentStatus } from '@roofline/shared';

// A 1,000-row customer import with known duplicates, bad rows and existing customers.
// Data row i (1..1000) is spreadsheet row i + 1, because row 1 is the header.
const HEADER = ' Customer Name ,CELL,E-Mail,Street Address,city,ST,Zip Code,Notes';
const BAD_PHONES = ['555-0144', '12', 'call me'] as const;

export function buildImportFixture(): {
  csv: string;
  existing: { name: string; phone: string; consent: ConsentStatus; doNotContact: boolean; optedOut: boolean }[];
} {
  const existing: {
    name: string;
    phone: string;
    consent: ConsentStatus;
    doNotContact: boolean;
    optedOut: boolean;
  }[] = [];
  for (let k = 0; k < 50; k += 1) {
    let consent: ConsentStatus;
    let doNotContact = false;
    let optedOut = false;
    if (k < 10) {
      consent = 'revoked';
      optedOut = true;
    } else if (k < 20) {
      consent = 'written';
    } else if (k < 30) {
      consent = 'express';
      doNotContact = true;
    } else if (k < 40) {
      consent = 'none';
    } else {
      consent = 'express';
    }
    existing.push({ name: `Existing ${k}`, phone: `+1402555${2000 + k}`, consent, doNotContact, optedOut });
  }

  const lines: string[] = [HEADER];
  for (let i = 1; i <= 1000; i += 1) {
    let name = `Customer ${i}`;
    let phone: string;
    if (i <= 850) {
      phone = `(402) 555-${1000 + i}`;
    } else if (i <= 900) {
      phone = `+1402555${2000 + (i - 851)}`;
    } else if (i <= 940) {
      phone = `402.555.${1000 + (i - 900)}`;
    } else if (i <= 970) {
      phone = BAD_PHONES[(i - 941) % 3] as string;
    } else if (i <= 985) {
      name = '';
      phone = `(402) 555-${3000 + i}`;
    } else {
      phone = '';
    }
    lines.push([name, phone, '', `${1000 + i} Pine St`, 'Omaha', 'NE', '68102', ''].join(','));
  }

  return { csv: `${lines.join('\n')}\n`, existing };
}
