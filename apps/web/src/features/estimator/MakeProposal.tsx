import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { MeasurementView, ProposalView } from '@roofline/shared';
import { Button, Checkbox, Field, Pill } from '@roofline/ui';
import { estimator } from '../../copy/estimator.ts';
import { useBuildProposal, useMeasure, useSendProposal } from './api.ts';
import type { MakeTarget } from './types.ts';
import styles from './MakeProposal.module.css';

/** Measure, build and send a proposal for one target; a roof we cannot outline goes to the draw window. */
export function MakeProposal({ target }: { target: MakeTarget }) {
  const navigate = useNavigate();
  const measure = useMeasure();
  const build = useBuildProposal();
  const send = useSendProposal();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [askedByText, setAskedByText] = useState(false);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const busyRef = useRef(false);
  const measurementRef = useRef<MeasurementView | null>(null);
  const proposalRef = useRef<ProposalView | null>(null);

  const isAddress = target.kind === 'address';
  const blocked = isAddress && (name.trim() === '' || phone.trim() === '');

  async function run() {
    if (busyRef.current || blocked) return;
    busyRef.current = true;
    setRunning(true);
    setFailed(false);
    try {
      const measurement =
        measurementRef.current ??
        (await measure.mutateAsync(
          target.kind === 'home' ? { propertyId: target.propertyId } : { address: target.address },
        ));
      measurementRef.current = measurement;
      if (measurement.drawMode) {
        navigate(`/estimator/measure/${measurement.id}`);
        return;
      }
      const proposal =
        proposalRef.current ??
        (await build.mutateAsync({
          measurementId: measurement.id,
          ...(target.kind === 'address'
            ? { customer: { name: name.trim(), phone: phone.trim(), askedByText } }
            : {}),
        }));
      proposalRef.current = proposal;
      const sent = await send.mutateAsync(proposal.id);
      navigate(`/approvals/${sent.taskId}`);
    } catch {
      setFailed(true);
    } finally {
      busyRef.current = false;
      setRunning(false);
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.target}>
        <p className={styles.targetText}>{target.kind === 'home' ? target.label : target.address}</p>
        <Pill tone="neutral">{estimator.estimateNote}</Pill>
      </div>
      {isAddress ? (
        <div className={styles.form}>
          <h3 className={styles.heading}>{estimator.newCustomerTitle}</h3>
          <Field label={estimator.customerName} value={name} onChange={(e) => setName(e.target.value)} />
          <Field
            label={estimator.customerPhone}
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Checkbox label={estimator.askedByText} checked={askedByText} onChange={setAskedByText} />
        </div>
      ) : null}
      <Button variant="primary" disabled={running || blocked} onClick={() => void run()}>
        {running ? estimator.makingProposal : estimator.makeProposal}
      </Button>
      {failed ? (
        <p role="alert" className={styles.error}>
          {estimator.makeFailed}
        </p>
      ) : null}
    </div>
  );
}
