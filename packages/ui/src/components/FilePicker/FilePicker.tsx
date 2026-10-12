import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { Button } from '../Button/Button.tsx';
import { FieldMessages, useFieldA11y } from '../Field/fieldParts.tsx';
import styles from './FilePicker.module.css';

export type FilePickerProps = {
  label: string;
  buttonLabel: string;
  dropLabel: string;
  accept: string;
  onFile(file: File): void;
  help?: string;
  error?: string;
  busy?: boolean;
};

type ZoneState = 'idle' | 'over';

/** A file chooser with a drop zone. Dropping or picking a file calls onFile with the first file. */
export function FilePicker({
  label,
  buttonLabel,
  dropLabel,
  accept,
  onFile,
  help,
  error,
  busy = false,
}: FilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [zoneState, setZoneState] = useState<ZoneState>('idle');
  const a11y = useFieldA11y({ help, error });

  function handlePick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    // Clear the input so picking the same file again still fires a change.
    e.target.value = '';
  }

  function handleOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setZoneState('over');
  }

  function handleLeave() {
    setZoneState('idle');
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setZoneState('idle');
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  }

  return (
    <div className={styles.picker}>
      <p className={styles.label}>{label}</p>
      <div
        className={styles.zone}
        data-state={zoneState}
        onDragEnter={handleOver}
        onDragOver={handleOver}
        onDragLeave={handleLeave}
        onDrop={handleDrop}
      >
        {dropLabel}
      </div>
      <Button type="button" busy={busy} onClick={() => inputRef.current?.click()}>
        {buttonLabel}
      </Button>
      {/* Opened by the button above, so it stays out of the tab order. */}
      <input
        ref={inputRef}
        id={a11y.id}
        type="file"
        className="visually-hidden"
        accept={accept}
        aria-label={label}
        aria-describedby={a11y['aria-describedby']}
        aria-invalid={a11y['aria-invalid']}
        tabIndex={-1}
        onChange={handlePick}
      />
      <FieldMessages help={help} helpId={a11y.helpId} error={error} errorId={a11y.errorId} />
    </div>
  );
}
