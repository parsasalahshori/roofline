import { useState } from 'react';
import { Button, Select } from '@roofline/ui';
import { IMPORT_FIELDS, type ImportField, type ImportMapping, type ImportView } from '@roofline/shared';
import { ApiError } from '../../api/client.ts';
import { errors } from '../../copy/errors.ts';
import { importCopy } from '../../copy/import.ts';
import { useSetMapping } from './api.ts';
import styles from './ImportWizard.module.css';

export type MappingStepProps = { view: ImportView; onBack?: () => void; onNext: () => void };

const FIELD_LABELS: Record<ImportField, string> = {
  name: importCopy.fieldName,
  firstName: importCopy.fieldFirstName,
  lastName: importCopy.fieldLastName,
  phone: importCopy.fieldPhone,
  phone2: importCopy.fieldPhone2,
  email: importCopy.fieldEmail,
  street: importCopy.fieldStreet,
  city: importCopy.fieldCity,
  state: importCopy.fieldState,
  zip: importCopy.fieldZip,
  notes: importCopy.fieldNotes,
  stage: importCopy.fieldStage,
};

/** Maps each Roofline detail to a column of the uploaded file. Next saves the mapping. */
export function MappingStep({ view, onBack, onNext }: MappingStepProps) {
  const [values, setValues] = useState<Record<ImportField, string>>(() => {
    const initial = {} as Record<ImportField, string>;
    for (const field of IMPORT_FIELDS) {
      const column = view.mapping[field];
      initial[field] = column === undefined ? '' : String(column);
    }
    return initial;
  });
  const mutation = useSetMapping(view.id);

  const options = [
    { value: '', label: importCopy.dontImport },
    ...view.headers.map((header, index) => ({ value: String(index), label: header })),
  ];

  const mappingError = mutation.isError ? (mutation.error instanceof ApiError ? mutation.error.message : errors.generic) : undefined;

  function handleNext() {
    const mapping: ImportMapping = {};
    for (const field of IMPORT_FIELDS) {
      const value = values[field];
      if (value !== '') mapping[field] = Number(value);
    }
    mutation.mutate(mapping, { onSuccess: () => onNext() });
  }

  return (
    <div className={styles.wizard}>
      <h2 className={styles.title}>{importCopy.mappingTitle}</h2>
      <p className={styles.note}>{importCopy.mappingHelp}</p>
      {mappingError ? (
        <p className={styles.error} role="alert">
          {mappingError}
        </p>
      ) : null}
      <div className={styles.fields}>
        {IMPORT_FIELDS.map((field) => (
          <Select
            key={field}
            label={FIELD_LABELS[field]}
            value={values[field]}
            options={options}
            onChange={(value) => setValues((current) => ({ ...current, [field]: value }))}
          />
        ))}
      </div>
      <div className={styles.actions}>
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            {importCopy.back}
          </Button>
        ) : null}
        <Button variant="primary" busy={mutation.isPending} onClick={handleNext}>
          {importCopy.next}
        </Button>
      </div>
    </div>
  );
}
