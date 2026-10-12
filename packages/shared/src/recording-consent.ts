import type { ConsentRegime } from './front-desk.ts';

/**
 * States treated as all-party consent for the record. CT, OR and MI have
 * nuances (CT civil/criminal split, OR in-person vs phone, MI interpretations);
 * we treat them as all-party for the record only. Behaviour is the same
 * everywhere (spec Decision 12): every call opens with the same disclosure.
 */
export const ALL_PARTY_STATES: readonly string[] = ['CA', 'CT', 'FL', 'IL', 'MD', 'MA', 'MI', 'MT', 'NH', 'OR', 'PA', 'WA'];

/*
 * Area code -> state. Checked on 2026-10-12 (D1 Task 27) against the area-code geocoding table of Google's
 * libphonenumber (resources/geocoding/en/1.txt on master): no code in this table disagrees with it, and the
 * 30 US codes it lists that this table lacked were added (308 NE and 909 CA are long-established codes; the
 * rest are newer overlays). nationalnanpa.com was not reachable from that machine, so the NANPA list itself
 * has not been compared: 624 NY, 679 MI and 935 CA are in this table but in neither libphonenumber source,
 * and are kept until NANPA confirms them. Recheck against the NANPA area code report before launch.
 */
const AREA_CODES_BY_STATE: Record<string, string> = {
  AL: '205 251 256 334 659 938',
  AK: '907',
  AZ: '480 520 602 623 928',
  AR: '327 479 501 870',
  CA: '209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 738 747 760 805 818 820 831 840 858 909 916 925 935 949 951',
  CO: '303 719 720 748 970 983',
  CT: '203 475 860 959',
  DE: '302',
  DC: '202 771',
  FL: '239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954',
  GA: '229 404 470 478 678 706 762 770 912 943',
  HI: '808',
  ID: '208 986',
  IL: '217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 872',
  IN: '219 260 317 463 574 765 812 930',
  IA: '319 515 563 641 712',
  KS: '316 620 785 913',
  KY: '270 364 502 606 859',
  LA: '225 318 337 504 985',
  ME: '207',
  MD: '227 240 301 410 443 667',
  MA: '339 351 413 508 617 774 781 857 978',
  MI: '231 248 269 313 517 586 616 679 734 810 906 947 989',
  MN: '218 320 507 612 651 763 952',
  MS: '228 601 662 769',
  MO: '235 314 417 557 573 636 660 816 975',
  MT: '406',
  NE: '308 402 531',
  NV: '702 725 775',
  NH: '603',
  NJ: '201 551 609 640 732 848 856 862 908 973',
  NM: '505 575',
  NY: '212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934',
  NC: '252 336 472 704 743 828 910 919 980 984',
  ND: '701',
  OH: '216 220 234 283 326 330 380 419 440 513 567 614 740 937',
  OK: '405 539 572 580 918',
  OR: '458 503 541 971',
  PA: '215 223 267 272 412 445 484 570 582 610 717 724 814 835 878',
  RI: '401',
  SC: '803 821 839 843 854 864',
  SD: '605',
  TN: '423 615 629 731 865 901 931',
  TX: '210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979',
  UT: '385 435 801',
  VT: '802',
  VA: '276 434 540 571 686 703 757 804 826 948',
  WA: '206 253 360 425 509 564',
  WV: '304 681',
  WI: '262 274 353 414 534 608 715 920',
  WY: '307',
};

const STATE_BY_NPA: ReadonlyMap<string, string> = new Map(
  Object.entries(AREA_CODES_BY_STATE).flatMap(([state, codes]) =>
    codes.split(' ').map((npa): [string, string] => [npa, state]),
  ),
);

/** US state (or DC) for a 3-digit NANP area code; null for unknown, Canadian, Caribbean, toll-free or malformed input. */
export function stateForAreaCode(npa: string): string | null {
  if (typeof npa !== 'string') return null;
  const t = npa.trim();
  if (!/^\d{3}$/.test(t)) return null;
  return STATE_BY_NPA.get(t) ?? null;
}

function normState(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(t) ? t : null;
}

export function consentRegime(i: {
  callerE164: string;
  companyState: string | null;
  transferState?: string | null;
}): ConsentRegime {
  const m = typeof i.callerE164 === 'string' ? /^\+1(\d{3})\d{7}$/.exec(i.callerE164.trim()) : null;
  const callerState = m ? stateForAreaCode(m[1] as string) : null;
  const states = [callerState, normState(i.companyState), normState(i.transferState)];
  return states.some((s) => s !== null && ALL_PARTY_STATES.includes(s)) ? 'all_party' : 'one_party';
}

export function disclosureGreeting(companyName: string): string {
  const trimmed = typeof companyName === 'string' ? companyName.trim() : '';
  const name = trimmed === '' ? 'our team' : trimmed;
  return `Thanks for calling ${name}. I'm ${name}'s virtual assistant, and this call is recorded. How can I help?`;
}
