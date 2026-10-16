import { Button, Icon } from '@roofline/ui';
import { useRef } from 'react';
import { settings } from '../../copy/settings.ts';
import styles from './SaveBar.module.css';
import { useClearOfBar } from './useClearOfBar.ts';

export type SaveBarProps = {
  /** The bar is there only while the form has something to save. */
  dirty: boolean;
  /** A save is on its way: both buttons wait. */
  saving: boolean;
  /** What the main button says, as the tab's own copy has it ("Save", "Save changes"). */
  saveLabel: string;
  /** Puts the form back to what was last saved. */
  onDiscard: () => void;
  /** The form cannot be saved yet (a box is empty); the bar still shows so the person sees there is something to fix. */
  saveDisabled?: boolean;
};

/**
 * The last thing inside a form: it waits at the foot of the screen while the form has changes, so Save is always in
 * reach however far down the field is. It is the form's submit button, so Enter in a field saves too. Put it inside
 * the `<form>`, after the panels, and it stays within the form's own height.
 */
export function SaveBar({ dirty, ...rest }: SaveBarProps) {
  return dirty ? <Bar {...rest} /> : null;
}

/** The bar itself, mounted only while there is something to save, so the room it takes from the column lasts exactly that long. */
function Bar({ saving, saveLabel, onDiscard, saveDisabled = false }: Omit<SaveBarProps, 'dirty'>) {
  const ref = useRef<HTMLDivElement>(null);
  useClearOfBar(ref);
  return (
    <div ref={ref} role="group" aria-label={settings.saveBar.label} className={styles.bar}>
      <p className={styles.text}>
        <Icon name="pen" size={16} />
        {settings.saveBar.unsaved}
      </p>
      <div className={styles.actions}>
        <Button variant="default" disabled={saving} onClick={onDiscard}>
          {settings.saveBar.discard}
        </Button>
        <Button type="submit" variant="primary" busy={saving} disabled={saveDisabled}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
