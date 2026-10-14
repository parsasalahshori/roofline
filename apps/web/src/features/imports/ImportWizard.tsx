import { useState } from 'react';
import { useParams } from 'react-router';
import { EmptyState, Skeleton } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { importCopy } from '../../copy/import.ts';
import { ConsentStep } from './ConsentStep.tsx';
import { MappingStep } from './MappingStep.tsx';
import { PreviewStep } from './PreviewStep.tsx';
import { ProgressStep } from './ProgressStep.tsx';
import { useImport } from './api.ts';
import { UploadStep } from './UploadStep.tsx';
import styles from './ImportWizard.module.css';

/** The customer import wizard: upload, then mapping, preview and consent, then progress and the summary. */
export function ImportWizard() {
  const { importId } = useParams();
  return (
    <div className={styles.container}>
      {importId ? <ImportDetail key={importId} importId={importId} /> : <><ImportSteps current={0} /><UploadStep /></>}
    </div>
  );
}

/** The current screen, not a claim that an asynchronous import has finished. */
function ImportSteps({ current }: { current: number }) {
  return (
    <ol className={styles.steps} aria-label={importCopy.stepsLabel}>
      {importCopy.steps.map((label, index) => (
        <li key={label} aria-current={current === index ? 'step' : undefined}>
          <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span>{label}
        </li>
      ))}
    </ol>
  );
}

type ImportDetailProps = { importId: string };
type Step = 'mapping' | 'preview' | 'consent';

function ImportDetail({ importId }: ImportDetailProps) {
  const [step, setStep] = useState<Step>('mapping');
  // Attested is false here; the consent step asks with its own checkbox state, and a start writes its answer to every cached copy.
  const query = useImport(importId, false);
  const view = query.data;

  if (view === undefined) {
    if (query.isError) {
      const message = query.error instanceof ApiError ? query.error.message : importCopy.loadError;
      return <EmptyState title={message} />;
    }
    return <Skeleton lines={3} />;
  }

  if (view.status === 'uploaded') {
    return (
      <>
        <ImportSteps current={step === 'mapping' ? 1 : step === 'preview' ? 2 : 3} />
        {step === 'mapping' ? <MappingStep view={view} onNext={() => setStep('preview')} /> :
          step === 'preview' ? <PreviewStep view={view} onBack={() => setStep('mapping')} onNext={() => setStep('consent')} /> :
            <ConsentStep importId={importId} onBack={() => setStep('preview')} />}
      </>
    );
  }

  return <><ImportSteps current={4} /><ProgressStep view={view} /></>;
}
