import { doors } from '../../../copy/doors.ts';

/** True for an iPhone, iPad or iPod: those open Apple Maps for directions. */
export function isIos(userAgent: string): boolean {
  return /iPad|iPhone|iPod/.test(userAgent);
}

/** The directions link for one door: Apple Maps on iOS, Google Maps everywhere else. */
export function navigateUrl(stop: { lat: number; lng: number }, ios: boolean): string {
  const base = ios ? doors.navigateAppleBase : doors.navigateGoogleBase;
  return `${base}${stop.lat},${stop.lng}`;
}
