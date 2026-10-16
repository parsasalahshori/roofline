import { FilePicker, Panel } from '@roofline/ui';
import { useNavigate } from 'react-router';
import { importCopy } from '../../copy/import.ts';
import { useUploadImport } from './api.ts';
import styles from './ImportWizard.module.css';

/** The first step: pick a CSV or Excel file. A successful upload opens the mapping step for the new import. */
export function UploadStep() {
  const mutation = useUploadImport();
  const navigate = useNavigate();

  function handleFile(file: File) {
    // FilePicker still calls onFile for a drop while busy, so ignore it here.
    if (mutation.isPending) return;
    mutation.mutate(file, { onSuccess: (view) => navigate(view.id) });
  }

  return (
    <Panel title={importCopy.uploadTitle}>
      <div className={styles.picker}>
        <FilePicker
          label={importCopy.uploadLabel}
          buttonLabel={importCopy.uploadButton}
          dropLabel={importCopy.uploadDrop}
          accept=".csv,.xlsx"
          help={importCopy.uploadHelp}
          busy={mutation.isPending}
          error={mutation.error?.message}
          onFile={handleFile}
        />
      </div>
    </Panel>
  );
}
