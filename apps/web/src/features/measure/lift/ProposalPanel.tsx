import { Button, Skeleton } from '@roofline/ui';
import type { Tier } from '@roofline/shared';
import { useState, type ReactNode } from 'react';
import { liftProposal } from '../../../copy/liftMeasure.ts';
import type { MeasurementPreview, PreviewOption } from '../types.ts';
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

function TierCard({ option, checked, onPick }: { option: PreviewOption; checked: boolean; onPick: () => void }) {
  const tierName = liftProposal.tier[option.tier];
  const note = option.highlights.slice(1, 3).join(', ');
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
          {option.tier === RECOMMENDED ? (
            <span className={styles.recommended}>
              <AiMark size={11} />
              {liftProposal.recommended}
            </span>
          ) : null}
        </span>
        <span className={styles.tierMaterial}>{option.name}</span>
        {note !== '' ? <span className={styles.tierNote}>{note}</span> : null}
      </span>
      <span className={styles.tierPrice}>
        <span className={styles.price}>{wholeDollars(option.totalCents)}</span>
        {option.monthlyEstimateCents !== null ? (
          <span className={styles.monthly}>{liftProposal.perMonth(wholeDollars(option.monthlyEstimateCents))}</span>
        ) : null}
      </span>
    </Button>
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
  const options = (preview?.options ?? []).filter((o) => o.enabled);
  const [picked, setPicked] = useState<Tier | null>(null);
  const selected = options.find((o) => o.tier === picked) ?? options.find((o) => o.tier === RECOMMENDED) ?? options[0];
  const name = firstName(customerName ?? preview?.customerName);
  const lines = selected ? panelLines(selected) : null;
  const squares = selected ? squaresFor(selected) : null;
  const financing = preview?.financing ?? null;

  return (
    <aside className={styles.panel} aria-label={liftProposal.label}>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{liftProposal.title(name)}</h2>
          <span className={styles.built}>
            <AiMark size={13} />
            {liftProposal.builtBy}
          </span>
        </div>
        {squares !== null ? <p className={styles.squares}>{liftProposal.squaresLine(squares.ordered, squares.measured, squares.wastePct)}</p> : null}
        {sections !== null ? (
          <p className={styles.squares} data-sections="">
            {sections}
          </p>
        ) : null}
      </div>
      <div className={styles.scroll}>
        {options.length > 0 ? (
          <div className={styles.tiers} role="radiogroup" aria-label={liftProposal.tiersLabel}>
            {options.map((o) => (
              <TierCard key={o.tier} option={o} checked={o.tier === selected?.tier} onPick={() => setPicked(o.tier)} />
            ))}
          </div>
        ) : pending ? (
          <div className={styles.note} aria-busy="true">
            <Skeleton lines={3} />
            <span className="visually-hidden">{liftProposal.loading}</span>
          </div>
        ) : (
          <p className={styles.note}>{failed ? liftProposal.failed : preview?.options === null && preview !== undefined ? liftProposal.noPrices : liftProposal.noRoof}</p>
        )}
        {controls}
        {selected && lines ? (
          <div className={styles.breakdown}>
            <Lines title={liftProposal.materialsFor(liftProposal.tier[selected.tier])} lines={lines.materials} />
            <Lines title={liftProposal.laborAndFees} lines={lines.labor} />
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
            {selected.monthlyEstimateCents !== null && financing !== null ? (
              <p className={styles.finance}>
                {liftProposal.monthlyLead}
                <b>{liftProposal.perMonth(wholeDollars(selected.monthlyEstimateCents))}</b>
                {liftProposal.monthlyRest((financing.aprBps / 100).toFixed(2), financing.months)}
              </p>
            ) : null}
          </>
        ) : null}
        {footer}
      </div>
    </aside>
  );
}
