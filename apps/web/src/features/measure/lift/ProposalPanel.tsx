import { Button, Skeleton } from '@roofline/ui';
import type { Tier } from '@roofline/shared';
import { useState, type ReactNode } from 'react';
import { liftProposal } from '../../../copy/liftMeasure.ts';
import type { MeasurementPreview } from '../types.ts';
import { AiMark } from './AiMark.tsx';
import { panelLines, squaresFor, wholeDollars, type PanelLine } from './proposalLines.ts';
import styles from './ProposalPanel.module.css';

const RECOMMENDED: Tier = 'better';

function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first === undefined || first === '' ? null : first;
}

function Lines({ title, lines }: { title: string; lines: PanelLine[] }) {
  if (lines.length === 0) return null;
  return (
    <section className={styles.group}>
      <h4 className={styles.groupTitle}>{title}</h4>
      <ul className={styles.lines}>
        {lines.map((l) => (
          <li key={l.key} className={styles.line}>
            <span className={styles.lineName}>{l.name}</span>
            <span className={styles.lineQty}>{l.quantity}</span>
            <span className={styles.lineCost}>{wholeDollars(l.cents)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One tier as the panel shows it, whatever it prices (a roof or windows). */
export type TierOption = {
  tier: Tier;
  /** The material or product line under the tier's name. */
  name: string;
  note: string;
  totalCents: number;
  monthlyCents: number | null;
  /** The chosen tier's breakdown, group by group (empty groups are left out). */
  groups: { title: string; lines: PanelLine[] }[];
  /** Under the total when this tier is chosen (the monthly line), or null. */
  finance: ReactNode;
};

function TierCard({
  option,
  checked,
  onPick,
  recommended = RECOMMENDED,
  badge = true,
}: {
  option: TierOption;
  checked: boolean;
  onPick: () => void;
  recommended?: Tier;
  badge?: boolean;
}) {
  const tierName = liftProposal.tier[option.tier];
  return (
    <Button
      variant="ghost"
      role="radio"
      aria-checked={checked}
      className={styles.tier}
      data-checked={checked ? 'true' : undefined}
      onClick={onPick}
    >
      <span className={styles.radio} aria-hidden="true">
        {checked ? <span className={styles.radioDot} /> : null}
      </span>
      <span className={styles.tierText}>
        <span className={styles.tierHead}>
          <span className={styles.tierName}>{tierName}</span>
          {badge && option.tier === recommended ? (
            <span className={styles.recommended}>
              <AiMark size={11} />
              {liftProposal.recommended}
            </span>
          ) : null}
        </span>
        <span className={styles.tierMaterial}>{option.name}</span>
        {option.note !== '' ? <span className={styles.tierNote}>{option.note}</span> : null}
      </span>
      <span className={styles.tierPrice}>
        <span className={styles.price}>{wholeDollars(option.totalCents)}</span>
        {option.monthlyCents !== null ? <span className={styles.monthly}>{liftProposal.perMonth(wholeDollars(option.monthlyCents))}</span> : null}
      </span>
    </Button>
  );
}

/**
 * The proposal column: a title, the lines under it (`subline`), Good, Better and Best to pick from (Better picked
 * first), the controls the window hands in, the picked tier's breakdown, its total, and the window's footer (the send
 * button). The roof's ProposalPanel and the windows' quote both draw through it, so they look the same.
 */
export function TierPanel({
  title,
  subline = null,
  options,
  pending,
  emptyNote,
  controls = null,
  footer,
  recommended = RECOMMENDED,
  vouched = true,
}: {
  title: string;
  /** The lines under the title; may follow the tier picked. */
  subline?: ReactNode | ((picked: Tier | undefined) => ReactNode);
  options: TierOption[];
  pending: boolean;
  /** What shows when there are no tiers and nothing is loading. */
  emptyNote: string;
  controls?: ReactNode;
  footer: ReactNode;
  /** The tier marked Recommended and chosen first (the better tier unless the measurement says otherwise). */
  recommended?: Tier;
  /**
   * Whether the numbers are good enough to vouch for: the "Built by Estimator" mark and the Recommended badge. False for
   * a draft (an estimated gutter length nobody checked); the recommended tier is still the one picked first.
   */
  vouched?: boolean;
}) {
  const [picked, setPicked] = useState<Tier | null>(null);
  const selected = options.find((o) => o.tier === picked) ?? options.find((o) => o.tier === recommended) ?? options[0];
  return (
    <aside className={styles.panel} aria-label={liftProposal.label}>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{title}</h2>
          {vouched ? (
            <span className={styles.built}>
              <AiMark size={13} />
              {liftProposal.builtBy}
            </span>
          ) : null}
        </div>
        {typeof subline === 'function' ? subline(selected?.tier) : subline}
      </div>
      <div className={styles.scroll}>
        {options.length > 0 ? (
          <div className={styles.tiers} role="radiogroup" aria-label={liftProposal.tiersLabel}>
            {options.map((o) => (
              <TierCard key={o.tier} option={o} checked={o.tier === selected?.tier} onPick={() => setPicked(o.tier)} recommended={recommended} badge={vouched} />
            ))}
          </div>
        ) : pending ? (
          <div className={styles.note} aria-busy="true">
            <Skeleton lines={3} />
            <span className="visually-hidden">{liftProposal.loading}</span>
          </div>
        ) : (
          <p className={styles.note}>{emptyNote}</p>
        )}
        {controls}
        {selected ? (
          <div className={styles.breakdown}>
            {selected.groups.map((g) => (
              <Lines key={g.title} title={g.title} lines={g.lines} />
            ))}
          </div>
        ) : null}
      </div>
      <div className={styles.foot}>
        {selected ? (
          <>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>{liftProposal.totalFor(liftProposal.tier[selected.tier])}</span>
              <span className={styles.total}>{wholeDollars(selected.totalCents)}</span>
            </div>
            {selected.finance}
          </>
        ) : null}
        {footer}
      </div>
    </aside>
  );
}

/**
 * The right column once the roof is measured: Good, Better and Best as Make proposal would price them now (the
 * preview read), the chosen tier's materials and labor, its total and monthly line, then the controls the window
 * hands in (price choice, customer) and the send button.
 */
export function ProposalPanel({
  preview,
  pending,
  failed,
  customerName,
  sections = null,
  controls,
  footer,
}: {
  preview: MeasurementPreview | undefined;
  pending: boolean;
  failed: boolean;
  customerName: string | null;
  /** "Sections A, C and D only (3 of 7)" when the quote covers only part of the roof. */
  sections?: string | null;
  controls: ReactNode;
  footer: ReactNode;
}) {
  const previewOptions = (preview?.options ?? []).filter((o) => o.enabled);
  const name = firstName(customerName ?? preview?.customerName);
  const financing = preview?.financing ?? null;
  const options: TierOption[] = previewOptions.map((o) => {
    const lines = panelLines(o);
    return {
      tier: o.tier,
      name: o.name,
      note: o.highlights.slice(1, 3).join(', '),
      totalCents: o.totalCents,
      monthlyCents: o.monthlyEstimateCents,
      groups: [
        { title: liftProposal.materialsFor(liftProposal.tier[o.tier]), lines: lines.materials },
        { title: liftProposal.laborAndFees, lines: lines.labor },
      ],
      finance:
        o.monthlyEstimateCents !== null && financing !== null ? (
          <p className={styles.finance}>
            {liftProposal.monthlyLead}
            <b>{liftProposal.perMonth(wholeDollars(o.monthlyEstimateCents))}</b>
            {liftProposal.monthlyRest((financing.aprBps / 100).toFixed(2), financing.months)}
          </p>
        ) : null,
    };
  });
  const subline = (picked: Tier | undefined) => {
    const chosen = previewOptions.find((o) => o.tier === picked);
    const squares = chosen ? squaresFor(chosen) : null;
    return (
      <>
        {squares !== null ? <p className={styles.squares}>{liftProposal.squaresLine(squares.ordered, squares.measured, squares.wastePct)}</p> : null}
        {sections !== null ? (
          <p className={styles.squares} data-sections="">
            {sections}
          </p>
        ) : null}
      </>
    );
  };
  return (
    <TierPanel
      title={liftProposal.title(name)}
      subline={subline}
      options={options}
      pending={pending}
      emptyNote={failed ? liftProposal.failed : preview?.options === null && preview !== undefined ? liftProposal.noPrices : liftProposal.noRoof}
      controls={controls}
      footer={footer}
    />
  );
}
