import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { MeasurementView, ProposalView } from '@roofline/shared';
import { Button, Checkbox, Field } from '@roofline/ui';
import { estimator } from '../../copy/estimator.ts';
import { makeFailureMessage, useBuildProposal, useMeasure, useSendProposal } from './api.ts';
import type { MakeTarget, NewCustomerInput } from './types.ts';
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
  const [failed, setFailed] = useState<string | null>(null);
  const busyRef = useRef(false);
  const measurementRef = useRef<MeasurementView | null>(null);
  const proposalRef = useRef<ProposalView | null>(null);

  const needsCustomer = target.kind === 'address' || !target.hasCustomer;
  const blocked = needsCustomer && (name.trim() === '' || phone.trim() === '');

  async function run() {
    if (busyRef.current || blocked) return;
    busyRef.current = true;
    setRunning(true);
    setFailed(null);
    try {
      const measurement =
        measurementRef.current ??
        (await measure.mutateAsync(
          target.kind === 'home' ? { propertyId: target.propertyId } : { address: target.address },
        ));
      measurementRef.current = measurement;
      if (measurement.drawMode) {
        const customer: NewCustomerInput = { name: name.trim(), phone: phone.trim(), askedByText };
        navigate(`/estimator/measure/${measurement.id}`, { state: needsCustomer ? { customer } : {} });
        return;
      }
      const proposal =
        proposalRef.current ??
        (await build.mutateAsync({
          measurementId: measurement.id,
          ...(needsCustomer
            ? { customer: { name: name.trim(), phone: phone.trim(), askedByText } }
            : {}),
        }));
      proposalRef.current = proposal;
      const sent = await send.mutateAsync(proposal.id);
      navigate(`/approvals/${sent.taskId}`);
    } catch (error) {
      setFailed(makeFailureMessage(error));
    } finally {
      busyRef.current = false;
      setRunning(false);
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.target}>
        <p className={styles.targetText}>{target.kind === 'home' ? target.label : target.address}</p>
        <span className={styles.estimate}>{estimator.estimateNote}</span>
      </div>
      {needsCustomer ? (
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
      {failed !== null ? (
        <p role="alert" className={styles.error}>
          {failed}
        </p>
      ) : null}
    </div>
  );
}
