import { doors } from '../../../copy/doors.ts';
import type { DoorLead } from './types.ts';

/** What the "Wants a check" form holds while the person types. */
export type LeadDraft = { name: string; phone: string; email: string; okToText: boolean; note: string };

/** One message per field; `contact` means neither a phone nor an email was given. */
export type LeadErrors = { name?: string; contact?: string; phone?: string; email?: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Checks the draft. `lead` is set only when there are no errors. Phone numbers are sent as
 * +1 and ten digits; an empty phone, email or note is left out.
 */
export function validateLead(draft: LeadDraft): { errors: LeadErrors; lead: DoorLead | null } {
  const errors: LeadErrors = {};
  const name = draft.name.trim();
  const phone = draft.phone.trim();
  const email = draft.email.trim();
  const note = draft.note.trim();

  if (name === '') errors.name = doors.nameRequired;

  let phoneE164: string | undefined;
  if (phone !== '') {
    const digits = phone.replace(/\D/g, '');
    const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    if (national.length === 10) phoneE164 = `+1${national}`;
    else errors.phone = doors.phoneInvalid;
  }

  if (phone === '' && email === '') errors.contact = doors.contactRequired;

  if (email !== '' && !EMAIL.test(email)) errors.email = doors.emailInvalid;

  if (Object.keys(errors).length > 0) return { errors, lead: null };

  const lead: DoorLead = { name, okToText: draft.okToText };
  if (phoneE164 !== undefined) lead.phoneE164 = phoneE164;
  if (email !== '') lead.email = email;
  if (note !== '') lead.note = note;
  return { errors, lead };
}
