import { CARRIERS, forwardingSteps, type Carrier } from '@roofline/shared';
import { Banner, Button, EmptyState, Listbox, Panel, Skeleton } from '@roofline/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { errors } from '../../../copy/errors.ts';
import { forwarding } from '../../../copy/forwarding.ts';
import { formatPhone } from '../../../lib/phone.ts';
import { useCompany } from '../../settings/api.ts';
import form from '../../settings/form.module.css';
import { useTexting } from '../../texting/api.ts';
import { ForwardingTest } from './ForwardingTest.tsx';
import styles from './ForwardingGuide.module.css';

/*
 * Settings -> Front Desk, below the form: how to send the business number's calls to the Roofline
 * number. The carrier and mode pick the codes or steps; forwardingSteps() (shared) returns the
 * strings, which are shown here as data. The test button sits under the codes.
 */

const CARRIER_OPTIONS = CARRIERS.map((carrier) => ({ value: carrier, label: forwarding.carriers[carrier] }));
const MODE_OPTIONS = [
  { value: 'all', label: forwarding.modes.all },
  { value: 'no_answer', label: forwarding.modes.no_answer },
] as const;

type Mode = (typeof MODE_OPTIONS)[number]['value'];

function isMode(value: string): value is Mode {
  return MODE_OPTIONS.some((option) => option.value === value);
}

function isCarrier(value: string): value is Carrier {
  return (CARRIERS as readonly string[]).includes(value);
}

/** One group of codes or steps: a heading, then each string as large mono code on a sunken box with a copy button, or as an ordered list. */
function CodeGroup({
  label,
  kind,
  codes,
  copiedCode,
  onCopy,
}: {
  label: string;
  kind: 'dial' | 'steps';
  codes: string[];
  copiedCode: string | null;
  onCopy: (code: string) => void;
}) {
  if (codes.length === 0) return null;
  return (
    <div className={styles.group}>
      <h3 className={styles.groupTitle}>{label}</h3>
      {kind === 'dial' ? (
        codes.map((code) => (
          <div key={code} className={styles.codeRow}>
            <code className={styles.code}>{code}</code>
            <Button variant="default" size="sm" onClick={() => onCopy(code)}>
              {copiedCode === code ? forwarding.copied : forwarding.copy}
            </Button>
          </div>
        ))
      ) : (
        <ol className={styles.steps}>
          {codes.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function ForwardingGuide() {
  const location = useLocation();
  const sectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (location.hash === '#forwarding') sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [location.hash]);
  const texting = useTexting();
  const company = useCompany();
  const [carrier, setCarrier] = useState<Carrier>('verizon');
  const [mode, setMode] = useState<Mode>('all');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const rooflineNumber = texting.data?.number ?? null;
  const businessNumber = company.data?.phone ?? null;

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
    } catch {
      setCopiedCode(null);
    }
  }

  let body: ReactNode;
  if (texting.isPending) {
    body = <Skeleton lines={3} />;
  } else if (texting.isError) {
    body = (
      <EmptyState
        title={errors.generic}
        action={
          <Button variant="primary" onClick={() => void texting.refetch()}>
            {errors.tryAgain}
          </Button>
        }
      />
    );
  } else {
    const steps = rooflineNumber === null ? null : forwardingSteps(carrier, mode, rooflineNumber);
    body = (
      <>
        {rooflineNumber === null ? <Banner tone="info">{forwarding.noNumberYet}</Banner> : null}

        {steps ? (
          <div className={styles.codes}>
            <p className={styles.intro}>{steps.kind === 'dial' ? forwarding.dialIntro : forwarding.stepsIntro}</p>
            <CodeGroup label={forwarding.codesOnLabel} kind={steps.kind} codes={steps.on} copiedCode={copiedCode} onCopy={copyCode} />
            <CodeGroup label={forwarding.codesOffLabel} kind={steps.kind} codes={steps.off} copiedCode={copiedCode} onCopy={copyCode} />
            <ForwardingTest />
          </div>
        ) : null}
      </>
    );
  }

  const hasNumbers = businessNumber !== null || rooflineNumber !== null;
  return (
    <div id="forwarding" ref={sectionRef} className={styles.guide}>
      <Panel title={forwarding.title}>
        <div className={styles.card}>
          {hasNumbers ? (
            <dl className={form.facts}>
              {businessNumber !== null ? (
                <div className={form.fact}>
                  <dt className={form.factLabel}>{forwarding.businessNumberLabel}</dt>
                  <dd className={`${form.factValue} ${form.mono}`}>{formatPhone(businessNumber)}</dd>
                </div>
              ) : null}
              {rooflineNumber !== null ? (
                <div className={form.fact}>
                  <dt className={form.factLabel}>{forwarding.rooflineNumberLabel}</dt>
                  <dd className={`${form.factValue} ${form.mono}`}>{formatPhone(rooflineNumber)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {company.isSuccess && businessNumber === null ? <p className={form.help}>{forwarding.noBusinessNumber}</p> : null}

          <div className={form.grid}>
            <Listbox
              label={forwarding.carrierLabel}
              value={carrier}
              options={CARRIER_OPTIONS}
              onChange={(value) => {
                if (isCarrier(value)) {
                  setCarrier(value);
                  setCopiedCode(null);
                }
              }}
            />
            <Listbox
              label={forwarding.modeLabel}
              value={mode}
              options={MODE_OPTIONS}
              onChange={(value) => {
                if (isMode(value)) {
                  setMode(value);
                  setCopiedCode(null);
                }
              }}
            />
          </div>

          {body}
        </div>
      </Panel>
    </div>
  );
}
