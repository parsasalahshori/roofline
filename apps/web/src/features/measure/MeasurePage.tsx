import { Button, Icon, Page, PageSlotsContext, Segmented, type BreadcrumbItem } from '@roofline/ui';
import { useContext, type HTMLAttributes, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { measure } from '../../copy/measure.ts';
import { measureGutters } from '../../copy/measureGutters.ts';
import { measureWindows } from '../../copy/measureWindows.ts';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { shell } from '../../copy/shell.ts';
import { splitAddress } from './address.ts';
import styles from './MeasurePage.module.css';

/** What a measurement is for: the three tabs of the switch. The order sheet has none. */
export type MeasureSection = 'roof' | 'windows' | 'gutters';

/** Where each tab of the switch goes. A tab with no place to go (gutters before the roof is measured) is left out. */
export type MeasureLinks = { roof: string; windows: string; gutters?: string | null };

const SECTION_LABEL: Record<MeasureSection, string> = { roof: measureWindows.switchRoof, windows: measureWindows.switchWindows, gutters: measureGutters.switchGutters };
const SECTION_ICON = { roof: 'roof', windows: 'win', gutters: 'gutter' } as const;

type Props = {
  /** Which tab is on. 'order' is the factory order sheet: its trail starts at Factory orders and it has no switch. */
  section: MeasureSection | 'order';
  /** The address of what is open: the page title (its street) and the end of the trail. */
  address?: string | null;
  /** The title when nothing is open ("Measure"). */
  title?: string;
  /** The line under the title. */
  subtitle?: ReactNode;
  /** Buttons at the right of the title. */
  actions?: ReactNode;
  /** Controls for the right of the top bar when the page has no switch (the order sheet's save state). */
  barExtra?: ReactNode;
  links?: MeasureLinks;
  /** The title is read out but not drawn: the content draws its own header (the order ticket). */
  titleHidden?: boolean;
  /** flow: the page scrolls (windows, gutters, the order). fill: the page is the screen's height and its panels scroll (the roof's map). */
  layout?: 'flow' | 'fill';
  children: ReactNode;
};

/**
 * The head every Measure screen shares: the trail in the top bar ("Measure > Windows > 305 Ridgeway Dr"), the Roof |
 * Windows | Gutters switch at the right of the bar, and the street as the page's title. On a phone the trail is
 * "Measure > 305 Ridgeway Dr", so the way back reads "‹ Measure".
 */
export function MeasurePage({ section, address = null, title, subtitle, actions, barExtra, links, titleHidden = false, layout = 'flow', children }: Props) {
  const navigate = useNavigate();
  const { phone } = useContext(PageSlotsContext);
  const parts = address !== null && address.trim() !== '' ? splitAddress(address) : null;
  const heading = parts?.street ?? title ?? measure.title;

  const crumbs: BreadcrumbItem[] = [];
  if (section === 'order') {
    crumbs.push({ label: WINDOW_COPY.orders.title, href: '/estimator/windows' });
  } else {
    crumbs.push({ label: measure.title, href: '/estimator' });
    // The section sits in the middle of the trail; a phone's way back is the item before the last, so it reads "Measure"
    if (!phone && (parts !== null || section !== 'roof')) {
      const href = parts !== null ? links?.[section] : undefined;
      crumbs.push(href ? { label: SECTION_LABEL[section], href } : { label: SECTION_LABEL[section] });
    }
  }
  if (parts !== null) crumbs.push({ label: parts.street });
  // Alone, "Measure" is the page itself: not a link to where it already is
  if (crumbs.length === 1 && section !== 'order') crumbs[0] = { label: measure.title };

  const switcher =
    section !== 'order' && links !== undefined ? (
      <Segmented
        label={measureWindows.switchLabel}
        value={section}
        onChange={(next: MeasureSection) => {
          const href = links[next];
          if (next !== section && href) void navigate(href);
        }}
        options={(['roof', 'windows', ...(links.gutters ? ['gutters' as const] : [])] as MeasureSection[]).map((value) => ({
          value,
          label: SECTION_LABEL[value],
          icon: <Icon name={SECTION_ICON[value]} size={16} />,
        }))}
      />
    ) : null;

  return (
    <Page
      title={heading}
      titleHidden={titleHidden}
      subtitle={subtitle}
      actions={actions}
      crumbs={crumbs}
      crumbsLabel={shell.crumbsLabel}
      barActions={switcher ?? barExtra}
      layout={layout}
    >
      {children}
    </Page>
  );
}

/**
 * The page's width as a container (see the css): the columns where they fit side by side, and the steps where they do
 * not. `stepsBelow` is the width under which the steps replace the columns: 980 for the roof's three, 600 for a phone.
 */
export function MeasureHost({ step, stepsBelow = 980, children, ...rest }: { step?: string; stepsBelow?: 600 | 980; children: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  return (
    <div {...rest} className={styles.host} data-step={step} data-steps-below={stepsBelow}>
      {children}
    </div>
  );
}

export type StepItem<K extends string> = { key: K; label: string; disabled?: boolean; done?: boolean };

/**
 * The phone's steps (Address, Windows, Quote): one column at a time where the three do not fit side by side. A tab list
 * with a numbered dot, a green check once the step is done; it is drawn only in the narrow layout.
 */
export function MeasureSteps<K extends string>({ label, steps, value, onChange }: { label: string; steps: ReadonlyArray<StepItem<K>>; value: K; onChange: (next: K) => void }) {
  return (
    <div className={styles.steps} role="tablist" aria-label={label}>
      {steps.map((step, index) => (
        <Button
          key={step.key}
          variant="ghost"
          role="tab"
          aria-selected={value === step.key}
          data-selected={value === step.key ? 'true' : undefined}
          data-done={step.done === true && value !== step.key ? 'true' : undefined}
          disabled={step.disabled === true}
          className={styles.step}
          onClick={() => onChange(step.key)}
        >
          <span className={styles.stepNumber} aria-hidden="true">
            {step.done === true && value !== step.key ? <Icon name="check" size={16} /> : index + 1}
          </span>
          {step.label}
        </Button>
      ))}
    </div>
  );
}
