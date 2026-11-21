import { BACKOFFICE_QUOTE_STATUSES, QUOTE_DOCUMENTS, TIERS, type BackofficeQuoteStatus, type Tier, type WindowDesign } from '@roofline/shared';
import { Banner, Button, Icon, IconButton, Segmented, Skeleton } from '@roofline/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useMe } from '../../../api/hooks.ts';
import { ApiError } from '../../../api/client.ts';
import { backofficeDesigner as copy } from '../../../copy/backofficeDesigner.ts';
import { canEditBackoffice } from '../access.ts';
import { documentHref, pickDraft, quoteKey, useAcceptQuote, useApproveDiscount, useBackofficeCatalog, useBackofficeQuote, usePutQuote } from './api.ts';
import '../apple.css';
import './apple.css';
import { duplicateDesign, newDesign } from './designs.ts';
import { dollars, previewQuote, type QuoteDraft } from './pricing.ts';
import { Group, Row, SelectRow } from './primitives.tsx';
import styles from './QuoteEditor.module.css';
import { UnitCard } from './UnitCard.tsx';
import { UnitInspector } from './UnitInspector.tsx';
import { useAutosave } from './useAutosave.ts';

const pct = (n: number) => (Number.isFinite(n) ? n : 0);

/** The quote editor: customer and address, a grid of unit cards, the unit editor beside it, and the price. Tablet first. */
export function QuoteEditor() {
  const { quoteId = '' } = useParams();
  const quote = useBackofficeQuote(quoteId);
  const catalog = useBackofficeCatalog();
  const queryClient = useQueryClient();
  const put = usePutQuote(quoteId);
  const approve = useApproveDiscount(quoteId);
  const accept = useAcceptQuote(quoteId);
  const me = useMe();
  const navigate = useNavigate();
  const imported = (useLocation().state as { measured?: { kept: number; skipped: number } } | null)?.measured;
  const autosave = useAutosave<QuoteDraft>((draft) => put.mutateAsync(draft));
  const draftRef = useRef<QuoteDraft | null>(null);
  const [draft, setDraftState] = useState<QuoteDraft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const current: QuoteDraft | null = draft ?? (quote.data ? pickDraft(quote.data) : null);
  useEffect(() => {
    draftRef.current = current;
  });

  function update(fn: (d: QuoteDraft) => QuoteDraft) {
    const base = draftRef.current;
    if (!base) return;
    const next = fn(base);
    draftRef.current = next;
    setDraftState(next);
    // The visualizer (and anything else on this quote) sees the change at once
    queryClient.setQueryData(quoteKey(quoteId), (q: unknown) => (q ? { ...(q as object), ...next } : q));
    autosave.change(next);
  }

  const preview = useMemo(() => (current && catalog.data ? previewQuote(current, catalog.data) : null), [current, catalog.data]);

  if (quote.isError || catalog.isError) {
    return (
      <div className="bo-apple">
        <div className={styles.state}>
          <Banner tone="danger" action={<Button variant="default" size="sm" onClick={() => { void quote.refetch(); void catalog.refetch(); }}>{copy.tryAgain}</Button>}>
            {copy.loadFailed}
          </Banner>
        </div>
      </div>
    );
  }
  if (!current || !catalog.data || !preview || !quote.data) {
    return (
      <div className="bo-apple">
        <div className={styles.state} aria-busy="true">
          <Skeleton />
        </div>
      </div>
    );
  }

  const cat = catalog.data;
  const tier = current.tier;
  const total = preview.totals[tier];
  // An accepted quote is locked (its order carries on); everything on it is for reading.
  const locked = quote.data.status === 'accepted';
  const canApprove = canEditBackoffice(me.data?.role);
  const approvedPercent = quote.data.discountApprovedPercent ?? null;
  const discountApproved = !preview.discountNeedsApproval || (approvedPercent !== null && approvedPercent >= current.discountPercent);
  const selected = locked ? null : (current.designs.find((d) => d.id === selectedId) ?? null);
  const issuesOf = (id: string) => preview.issues.filter((i) => i.designId === id);
  const errorCount = preview.issues.filter((i) => i.level === 'error').length;

  const replaceDesign = (next: WindowDesign) => update((d) => ({ ...d, designs: d.designs.map((x) => (x.id === next.id ? next : x)) }));
  const addUnit = () => {
    const made = newDesign(cat, copy.windowN(current.designs.length + 1));
    if (!made) return;
    update((d) => ({ ...d, designs: [...d.designs, made] }));
    setSelectedId(made.id);
  };
  const duplicate = (design: WindowDesign) => {
    const copied = duplicateDesign(design, copy.copyOf(design.label));
    update((d) => ({ ...d, designs: [...d.designs, copied] }));
    setSelectedId(copied.id);
  };
  const remove = (design: WindowDesign) => {
    update((d) => ({ ...d, designs: d.designs.filter((x) => x.id !== design.id) }));
    setSelectedId(null);
  };

  const blockedReason = current.designs.length === 0 ? copy.acceptNeedsDrawings : errorCount > 0 ? copy.acceptNeedsFixes : !discountApproved ? copy.acceptNeedsApproval : null;
  const actionError = [approve, accept].find((m) => m.isError)?.error;
  const actionMessage = actionError instanceof ApiError ? actionError.message : approve.isError ? copy.approveFailed : accept.isError ? copy.acceptFailed : null;

  // What is on screen is saved first, so the server approves and accepts the same quote the person is looking at.
  async function approveDiscount() {
    accept.reset();
    if (!(await autosave.flush())) return;
    approve.mutate();
  }
  async function acceptQuote() {
    approve.reset();
    if (!(await autosave.flush())) return;
    accept.mutate(undefined, { onSuccess: (order) => void navigate(`/backoffice/orders/${encodeURIComponent(order.id)}`) });
  }

  const accessoryAmount = (accessoryId: string) => preview.lines[tier].find((l) => l.accessoryId === accessoryId)?.amountCents ?? 0;
  const addable = cat.accessories.filter((a) => !a.archived && !current.accessories.some((x) => x.accessoryId === a.id));
  const saveText = autosave.state === 'saving' || autosave.state === 'waiting' ? copy.saving : autosave.state === 'error' ? copy.saveFailed : copy.saved;

  return (
    <div className="bo-apple">
      <div className={styles.page} data-inspector={selected ? 'open' : 'closed'}>
        <header className={styles.toolbar}>
          <div className={styles.toolbarTitle}>
            <h1 className={styles.customer}>{quote.data.customerName}</h1>
            <p className={styles.address}>{quote.data.address}</p>
          </div>
          <div className={styles.toolbarEnd}>
            <p className={styles.saveState} aria-live="polite" data-state={autosave.state}>
              <Icon name={autosave.state === 'error' ? 'alert' : autosave.state === 'saving' || autosave.state === 'waiting' ? 'clock' : 'check'} size={16} />
              {saveText}
            </p>
            <p className={styles.totalPill} aria-label={copy.totalFor(cat.tiers[tier].label)}>
              <span>{cat.tiers[tier].label}</span>
              <strong>{dollars(total.totalCents)}</strong>
            </p>
            <Button variant="default" href={`/backoffice/quotes/${encodeURIComponent(quoteId)}/visual`} aria-label={copy.openVisualizer}>
              <Icon name="camera" size={18} />
              <span className={styles.photoLabel}>{copy.openVisualizer}</span>
            </Button>
          </div>
        </header>

        <div className={styles.layout}>
          <main className={styles.main}>
            {autosave.state === 'error' ? (
              <Banner tone="danger" action={<Button variant="default" size="sm" onClick={() => void autosave.flush()}>{copy.tryAgain}</Button>}>
                {copy.saveFailedBody}
              </Banner>
            ) : null}
            {locked ? (
              <Banner tone="info" action={quote.data.orderId ? <Button variant="default" size="sm" href={`/backoffice/orders/${encodeURIComponent(quote.data.orderId)}`}>{copy.openOrder}</Button> : undefined}>
                {copy.lockedBanner}
              </Banner>
            ) : null}
            {imported ? <Banner tone="info">{[copy.startedFromMeasured(imported.kept), imported.skipped > 0 ? copy.skippedMeasured(imported.skipped) : ''].filter(Boolean).join(' ')}</Banner> : null}
            {errorCount > 0 && !locked ? <Banner tone="warning">{copy.problemsBanner(errorCount)}</Banner> : null}

            <section aria-labelledby="units-heading">
              <div className={styles.sectionHead}>
                <h2 id="units-heading" className={styles.sectionTitle}>
                  {copy.units}
                </h2>
                {locked ? null : (
                  <Button variant="primary" onClick={addUnit}>
                    <Icon name="plus" size={18} />
                    {copy.addUnit}
                  </Button>
                )}
              </div>
              {current.designs.length === 0 ? (
                <p className={styles.empty}>{copy.noUnits}</p>
              ) : (
                <ul className={styles.grid} data-compact={selected ? 'true' : undefined}>
                  {current.designs.map((d) => (
                    <li key={d.id}>
                      <UnitCard design={d} catalog={cat} tier={tier} issues={issuesOf(d.id)} selected={d.id === selectedId} onOpen={() => (locked ? undefined : setSelectedId(d.id === selectedId ? null : d.id))} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className={styles.summary}>
              <div className={styles.lockable} inert={locked || undefined}>
              <Group title={copy.groups.price}>
                <Row label={copy.tier} as="div" stacked>
                  <Segmented<Tier> label={copy.tier} value={tier} onChange={(t) => update((d) => ({ ...d, tier: t }))} options={TIERS.map((t) => ({ value: t, label: cat.tiers[t].label, count: dollars(preview.totals[t].totalCents) }))} />
                </Row>
                <Row label={copy.tierNote} as="div">
                  <span className={styles.note}>{cat.tiers[tier].note}</span>
                </Row>
              </Group>

              <Group title={copy.groups.accessories} footer={copy.accessoriesNote}>
                {current.accessories.map((a) => {
                  const acc = cat.accessories.find((x) => x.id === a.accessoryId);
                  return (
                    <Row key={a.accessoryId} label={acc?.label ?? copy.removedAccessory} as="div">
                      <span className={styles.money}>{dollars(accessoryAmount(a.accessoryId))}</span>
                      <IconButton label={copy.removeAccessory(acc?.label ?? '')} icon={<Icon name="x" size={18} />} onClick={() => update((d) => ({ ...d, accessories: d.accessories.filter((x) => x.accessoryId !== a.accessoryId) }))} />
                    </Row>
                  );
                })}
                {addable.length > 0 ? (
                  <SelectRow label={copy.addAccessory} value="" options={[{ value: '', label: copy.chooseOne }, ...addable.map((a) => ({ value: a.id, label: a.label }))]} onChange={(id) => id && update((d) => ({ ...d, accessories: [...d.accessories, { accessoryId: id, quantity: 1 }] }))} />
                ) : null}
              </Group>

              <Group title={copy.groups.totals} footer={preview.discountNeedsApproval ? copy.needsApproval(cat.maxRepDiscountPercent) : undefined}>
                <Row label={copy.subtotal} as="div">
                  <span className={styles.money}>{dollars(total.subtotalCents)}</span>
                </Row>
                {total.markupCents !== 0 ? (
                  <Row label={copy.markup} as="div">
                    <span className={styles.money}>{dollars(total.markupCents)}</span>
                  </Row>
                ) : null}
                <Row label={copy.discount}>
                  <input
                    className={styles.percent}
                    aria-label={copy.discount}
                    inputMode="decimal"
                    value={String(current.discountPercent)}
                    onChange={(e) => {
                      const n = Number(e.target.value.replace(/[^0-9.]/g, ''));
                      update((d) => ({ ...d, discountPercent: Math.min(pct(n), 100) }));
                    }}
                  />
                  <span className={styles.money}>{copy.percentSign}</span>
                </Row>
                {total.discountCents !== 0 ? (
                  <Row label={copy.discountAmount} as="div">
                    <span className={styles.money}>{dollars(-total.discountCents)}</span>
                  </Row>
                ) : null}
                {preview.discountNeedsApproval ? (
                  <Row label={copy.approvalLabel} as="div">
                    {discountApproved ? (
                      <span className={styles.approved} role="status">
                        {copy.discountApprovedBy(quote.data.discountApprovedBy ?? null, approvedPercent ?? current.discountPercent)}
                      </span>
                    ) : (
                      <>
                        <span className={styles.approval} role="status">
                          {copy.needsApprovalShort}
                        </span>
                        {canApprove ? (
                          <Button variant="default" size="sm" busy={approve.isPending} onClick={() => void approveDiscount()}>
                            {approve.isPending ? copy.approving : copy.approveDiscount}
                          </Button>
                        ) : null}
                      </>
                    )}
                  </Row>
                ) : null}
                <Row label={copy.total} as="div">
                  <strong className={styles.grand} data-testid="grand-total">
                    {dollars(total.totalCents)}
                  </strong>
                </Row>
              </Group>

              <Group title={copy.groups.status}>
                <Row label={copy.status} as="div" stacked>
                  {/* 'Accepted' is not a choice: only the Customer answer button below makes it (and the order). */}
                  <Segmented<BackofficeQuoteStatus> label={copy.status} value={current.status} onChange={(status) => update((d) => ({ ...d, status }))} options={BACKOFFICE_QUOTE_STATUSES.filter((s) => s !== 'accepted' || locked).map((s) => ({ value: s, label: copy.statuses[s] }))} />
                </Row>
              </Group>

              </div>

              {locked ? null : (
                <Group title={copy.groups.accept} footer={blockedReason ?? copy.acceptHint}>
                  <div className={styles.acceptRow}>
                    <Button variant="primary" busy={accept.isPending} disabled={blockedReason !== null} onClick={() => void acceptQuote()}>
                      {accept.isPending ? copy.accepting : copy.acceptQuote}
                    </Button>
                    {actionMessage ? <Banner tone="danger">{actionMessage}</Banner> : null}
                  </div>
                </Group>
              )}

              <Group title={copy.groups.documents} footer={copy.documentsNote}>
                {QUOTE_DOCUMENTS.map((kind) => (
                  <Button key={kind} variant="ghost" className={styles.rowLink} href={documentHref(quoteId, kind)} target="_blank" rel="noreferrer">
                    <span className={styles.rowLinkLabel}>
                      <Icon name="doc" size={18} />
                      {copy.documents[kind]}
                    </span>
                    <Icon name="chev" size={16} />
                  </Button>
                ))}
              </Group>
            </div>
          </main>

          {selected ? (
            <>
              <div className={styles.scrim} onClick={() => setSelectedId(null)} aria-hidden="true" />
              <aside className={styles.inspector} aria-label={copy.unitEditor(selected.label)}>
                <span className={styles.grabber} aria-hidden="true" />
                <UnitInspector
                  key={selected.id}
                  design={selected}
                  catalog={cat}
                  tier={tier}
                  issues={issuesOf(selected.id)}
                  onChange={replaceDesign}
                  onDuplicate={() => duplicate(selected)}
                  onDelete={() => remove(selected)}
                  onClose={() => setSelectedId(null)}
                />
              </aside>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
