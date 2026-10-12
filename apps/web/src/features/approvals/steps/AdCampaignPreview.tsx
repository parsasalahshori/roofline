import { dailyBudgetCents } from '@roofline/shared';
import { review as reviewCopy } from '../../../copy/review.ts';
import { stepAds } from '../../../copy/stepAds.ts';
import type { StepView } from '../../../api/types.ts';
import { useStorm } from '../../storm/api.ts';
import { outerRingsOf, SwathThumb } from './SwathThumb.tsx';
import styles from './AdCampaignPreview.module.css';
import { payloadOf, textOf } from './payload.ts';
import type { EditFieldSpec, EditValues, StepKit, StepPreviewProps } from './types.ts';

type Platform = keyof typeof stepAds.platformName;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function platformOf(value: unknown): Platform | null {
  return value === 'google' || value === 'meta' ? value : null;
}

/** The lines of a list field: an array as is, or a string one item per line. Trimmed, empties dropped. */
function linesOf(value: string | string[] | undefined): string[] {
  const items = Array.isArray(value) ? value : String(value ?? '').split('\n');
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

/** The company storm the campaign is for; '' when the payload has none (the swath is then not read). */
function stormIdOf(step: StepView): string {
  const id = payloadOf(step).companyStormId;
  return typeof id === 'string' ? id : '';
}

/** The campaign's values as the screen reads them. A number that is missing or not finite is null. */
function readAd(step: StepView) {
  const payload = payloadOf(step);
  const maxCents = isFiniteNumber(payload.maxSpendCents) ? payload.maxSpendCents : null;
  const days = isFiniteNumber(payload.days) ? payload.days : null;
  return {
    platform: platformOf(payload.platform),
    maxCents,
    days,
    headline: textOf(payload.headline),
    description: textOf(payload.description),
    keywords: Array.isArray(payload.keywords) ? payload.keywords.filter((k): k is string => typeof k === 'string') : [],
    primaryText: textOf(payload.primaryText),
    photoId: typeof payload.photoId === 'string' ? payload.photoId.toLowerCase() : null,
  };
}

/** The daily amount the platform budget uses: floor(max / days), never more than the approved maximum in total. */
function dailyText(maxCents: number, days: number): string {
  return stepAds.dailyFor(dailyBudgetCents(maxCents, days), days);
}

/** The lines the review list shows: the platform, then the daily amount. Null when the numbers are not valid. */
function reviewLines(step: StepView): { lines: string[]; maxSpendCents: number } | null {
  const ad = readAd(step);
  if (ad.platform === null || ad.maxCents === null || ad.maxCents <= 0 || ad.days === null || ad.days < 1) return null;
  return { lines: [stepAds.platformName[ad.platform], dailyText(ad.maxCents, ad.days)], maxSpendCents: ad.maxCents };
}

/**
 * The detailed review of a create_ad_campaign step: the approved maximum, the daily amount, the ad, and the
 * map of the storm's hail area (the swath; the ad circles are not on the web).
 */
export function AdCampaignPreview({ step, canApprove }: StepPreviewProps) {
  const ad = readAd(step);
  const title = step.preview?.title ?? '';
  const platformName = ad.platform === null ? null : stepAds.platformName[ad.platform];
  const showDaily = ad.maxCents !== null && ad.days !== null && ad.days >= 1;
  const stormQuery = useStorm(stormIdOf(step));
  const area = stormQuery.data !== undefined && outerRingsOf(stormQuery.data.swath).length > 0 ? stormQuery.data.swath : null;

  return (
    <div className={styles.preview}>
      <h3 className={styles.title}>{title}</h3>
      {ad.maxCents !== null ? <p className={styles.maximum}>{reviewCopy.spend(ad.maxCents)}</p> : null}
      {showDaily ? <p className={styles.daily}>{dailyText(ad.maxCents!, ad.days!)}</p> : null}
      {platformName !== null ? <p className={styles.platform}>{platformName}</p> : null}
      {ad.headline !== '' ? <p className={styles.headline}>{ad.headline}</p> : null}
      {ad.description !== '' ? <p className={styles.description}>{ad.description}</p> : null}
      {ad.platform === 'meta' ? (
        ad.primaryText !== '' ? <p className={styles.body}>{ad.primaryText}</p> : null
      ) : ad.keywords.length > 0 ? (
        <ul className={styles.keywords}>
          {ad.keywords.map((keyword, i) => (
            <li key={i}>{keyword}</li>
          ))}
        </ul>
      ) : null}
      {area !== null ? (
        <div className={styles.map}>
          <SwathThumb swath={area} />
          <p className={styles.caption}>{stepAds.hailNote}</p>
        </div>
      ) : null}
      {!canApprove ? <p className={styles.notice}>{stepAds.ownerOnly}</p> : null}
    </div>
  );
}

function editFields(step: StepView): EditFieldSpec[] {
  const ad = readAd(step);
  const fields: EditFieldSpec[] = [
    {
      id: 'maxSpend',
      label: stepAds.maxLabel,
      kind: 'number',
      inputMode: 'decimal',
      value: ad.maxCents === null ? '' : String(ad.maxCents / 100),
      ...(ad.maxCents === null ? {} : { help: stepAds.maxHelp(stepAds.money(ad.maxCents)) }),
    },
    { id: 'days', label: stepAds.daysLabel, kind: 'number', value: ad.days === null ? '' : String(ad.days) },
    { id: 'headline', label: stepAds.headlineLabel, kind: 'text', value: ad.headline },
    { id: 'description', label: stepAds.descriptionLabel, kind: 'multiline', value: ad.description },
  ];
  if (ad.platform === 'meta') {
    fields.push({ id: 'primaryText', label: stepAds.primaryTextLabel, kind: 'multiline', value: ad.primaryText });
  } else {
    fields.push({ id: 'keywords', label: stepAds.keywordsLabel, kind: 'lines', value: ad.keywords.join('\n') });
  }
  // The choices come from the company's Settings photos; the sheet fills them in.
  fields.push({
    id: 'photo',
    label: stepAds.photoLabel,
    kind: 'pick',
    value: [ad.photoId ?? ''],
    options: [{ value: '', label: stepAds.noPhoto }],
  });
  return fields;
}

function toPayload(step: StepView, values: EditValues): Record<string, unknown> {
  const payload = payloadOf(step);
  const ad = readAd(step);
  const next: Record<string, unknown> = {
    ...payload,
    maxSpendCents: Math.round(Number(values.maxSpend) * 100),
    days: Number(values.days),
    headline: String(values.headline ?? ''),
    description: String(values.description ?? ''),
  };
  if (ad.platform === 'meta') {
    next.primaryText = String(values.primaryText ?? '');
  } else {
    next.keywords = linesOf(values.keywords);
  }
  if (values.photo !== undefined) {
    // The photo sheet is a pick list: the last photo picked is the one used, and none picked means no photo.
    const picked = (Array.isArray(values.photo) ? values.photo : [values.photo]).filter((id) => id !== '');
    next.photoId = picked.length > 0 ? picked[picked.length - 1] : null;
  }
  return next;
}

/** A maximum above the step's current one is refused: Edit may lower it, never raise it. */
function fieldErrors(step: StepView, values: EditValues): Record<string, string> {
  const current = readAd(step).maxCents;
  const typed = Math.round(Number(values.maxSpend) * 100);
  if (current === null || !Number.isFinite(typed) || typed <= current) return {};
  return { maxSpend: stepAds.raisedError(stepAds.money(current)) };
}

export const adCampaignKit: StepKit = {
  Preview: AdCampaignPreview,
  review: (step) => {
    const lines = reviewLines(step);
    return lines === null ? step.preview : { ...step.preview, lines: lines.lines, maxSpendCents: lines.maxSpendCents };
  },
  editFields,
  toPayload,
  fieldErrors,
};
