import { useRef, type ReactNode } from 'react';
import { useClearOfBar } from '../settings/useClearOfBar.ts';
import styles from './WizardActions.module.css';

/**
 * The bar that ends a step: where the person is at the left (Step 2 of 5), Back and the button that moves on at the right.
 * It stays at the foot of the window while the step scrolls: on a phone the long mapping list never pushes Next out of reach.
 */
export function WizardActions({ status, children }: { status: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useClearOfBar(ref);
  return (
    <div ref={ref} className={styles.bar}>
      <p className={styles.status}>{status}</p>
      <div className={styles.buttons}>{children}</div>
    </div>
  );
}
