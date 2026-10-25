import { Field } from '@roofline/ui';
import { createContext, useContext, useState } from 'react';
import { centsToDollars, dollarsToCents } from '../format.ts';

/** Whether the person may change the price book. A rep sees the same screen with every box disabled. */
export const EditContext = createContext(true);
export const useCanEdit = (): boolean => useContext(EditContext);

type ParsedProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
  parse: (text: string) => number;
  format: (value: number) => string;
  error?: string;
  help?: string;
  labelHidden?: boolean;
  suffix?: string;
  align?: 'right';
};

/**
 * A box for a number that keeps what was typed while it is half-written ("12."), tells the parent only the number
 * it reads (NaN when it is not one), and takes the parent's value back when it changes from outside (Discard).
 */
function ParsedField({ label, value, onChange, parse, format, error, help, labelHidden, align }: ParsedProps) {
  const canEdit = useCanEdit();
  const [text, setText] = useState(() => format(value));
  const parsed = parse(text);
  if (!Object.is(parsed, value)) setText(format(value));
  return (
    <Field
      label={label}
      labelHidden={labelHidden}
      help={help}
      error={error}
      value={text}
      inputMode="decimal"
      disabled={!canEdit}
      style={align === 'right' ? { textAlign: 'right' } : undefined}
      onChange={(event) => {
        setText(event.target.value);
        onChange(parse(event.target.value));
      }}
    />
  );
}

const parseNumber = (text: string): number => (text.trim() === '' ? Number.NaN : /^-?\d*\.?\d*$/.test(text.trim()) && /\d/.test(text) ? Number(text) : Number.NaN);
const formatNumber = (value: number): string => (Number.isFinite(value) ? String(value) : '');

type NumProps = Pick<ParsedProps, 'label' | 'error' | 'help' | 'labelHidden'> & { value: number; onChange: (value: number) => void };

/** A plain number (inches, percent, counts). */
export function NumField(props: NumProps) {
  return <ParsedField {...props} parse={parseNumber} format={formatNumber} />;
}

/** Dollars in the box, cents in the data. */
export function DollarField(props: NumProps) {
  return <ParsedField {...props} parse={dollarsToCents} format={centsToDollars} />;
}
