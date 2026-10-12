import { Button, Card, useFocusTrap } from '@roofline/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { demo } from '../../copy/demo.ts';
import { type Simulation, useDemoMode, useSimulate } from './api.ts';
import styles from './DemoBadge.module.css';

const BUTTONS: { kind: Simulation; label: string }[] = [
  { kind: 'text', label: demo.simulateText },
  { kind: 'call', label: demo.simulateCall },
  { kind: 'storm', label: demo.simulateStorm },
  { kind: 'sign', label: demo.simulateSign },
];

/**
 * The Demo badge in the top bar, shown only when the API runs in demo mode. Pressing it opens the presenter's
 * Simulate panel: four buttons that make a homeowner text, a call, a hail storm or a signature happen, each
 * followed by the server's sentence about what happened.
 */
export function DemoBadge() {
  const isDemo = useDemoMode();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useFocusTrap(panelRef, { active: open, onEscape: close });

  useEffect(() => {
    if (!open) return;
    function onMouseDown(event: MouseEvent) {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  if (!isDemo) return null;

  return (
    <div ref={rootRef} className={styles.root}>
      <Button
        variant="ghost"
        className={styles.badge}
        data-testid="demo-badge"
        aria-label={demo.badgeLabel}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {demo.badge}
      </Button>
      {open ? (
        <div ref={panelRef} tabIndex={-1} className={styles.popover}>
          <Card as="section" aria-label={demo.panelTitle} data-testid="simulate-panel">
            <SimulatePanel />
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function SimulatePanel() {
  const simulate = useSimulate();
  const [running, setRunning] = useState<Simulation | null>(null);
  const message = simulate.isError ? simulate.error.message || demo.failed : simulate.data?.message;

  return (
    <div className={styles.panel}>
      <h2 className={styles.title}>{demo.panelTitle}</h2>
      <p className={styles.hint}>{demo.panelHint}</p>
      <ul className={styles.list}>
        {BUTTONS.map(({ kind, label }) => (
          <li key={kind}>
            <Button
              variant="ghost"
              className={styles.item}
              data-testid={`simulate-${kind}`}
              busy={simulate.isPending && running === kind}
              disabled={simulate.isPending}
              onClick={() => {
                setRunning(kind);
                simulate.mutate(kind);
              }}
            >
              {label}
            </Button>
          </li>
        ))}
      </ul>
      {message ? (
        <p className={styles.message} data-testid="simulate-message" data-tone={simulate.isError ? 'error' : 'ok'}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
