import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { EmptyState, Panel, Skeleton, Stepper } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { importCopy } from '../../copy/import.ts';
import { ConsentStep } from './ConsentStep.tsx';
import { MappingStep } from './MappingStep.tsx';
import { PreviewStep } from './PreviewStep.tsx';
import { ProgressStep } from './ProgressStep.tsx';
import { useImport } from './api.ts';
import { UploadStep } from './UploadStep.tsx';
import styles from './ImportWizard.module.css';

const STEPS = [
  { label: importCopy.steps.upload },
  { label: importCopy.steps.mapping },
  { label: importCopy.steps.preview },
  { label: importCopy.steps.consent },
  { label: importCopy.steps.run },
];

/** The steps in a panel, then the step in progress under them. */
function Frame({ current, children }: { current: number; children: ReactNode }) {
  return (
    <div className={styles.wizard}>
      <Panel>
        <Stepper label={importCopy.stepsLabel} steps={STEPS} current={current} doneLabel={importCopy.stepDone} />
      </Panel>
      {children}
    </div>
  );
}

/** The customer import wizard: upload, then mapping, preview and consent, then progress and the summary. */
export function ImportWizard() {
  const { importId } = useParams();
  return importId ? (
    <ImportDetail importId={importId} />
  ) : (
    <Frame current={1}>
      <UploadStep />
    </Frame>
  );
}

type ImportDetailProps = { importId: string };
type Step = 'mapping' | 'preview' | 'consent';

/** The step number of each stage of an uploaded file, after the upload itself. */
const STEP_NUMBER: Record<Step, number> = { mapping: 2, preview: 3, consent: 4 };

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
    return (
      <Panel>
        <Skeleton lines={3} />
      </Panel>
    );
  }

  if (view.status === 'uploaded') {
    return (
      <Frame current={STEP_NUMBER[step]}>
        {step === 'mapping' ? <MappingStep view={view} onNext={() => setStep('preview')} /> : null}
        {step === 'preview' ? (
          <PreviewStep view={view} onBack={() => setStep('mapping')} onNext={() => setStep('consent')} />
        ) : null}
        {step === 'consent' ? <ConsentStep importId={importId} onBack={() => setStep('preview')} /> : null}
      </Frame>
    );
  }

  // Queued, running or failed is the last step in progress; a finished import has every step done
  const running = view.status === 'queued' || view.status === 'processing' || view.status === 'failed';
  return (
    <Frame current={running ? STEPS.length : STEPS.length + 1}>
      <ProgressStep view={view} />
    </Frame>
  );
}
