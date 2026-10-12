/** A US number as (555) 123-0001, the country code dropped; any other number is shown as it was given. */
export function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return e164;
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}
