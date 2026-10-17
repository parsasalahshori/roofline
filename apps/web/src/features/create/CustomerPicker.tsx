import { Button, Field } from '@roofline/ui';
import { useEffect, useState } from 'react';
import { errors } from '../../copy/errors.ts';
import { create } from '../../copy/create.ts';
import { type CustomerRecord, useCustomerSearch } from './api.ts';
import styles from './Create.module.css';

export type CustomerPickerProps = {
  /** The chosen customer, or null. */
  selected: CustomerRecord | null;
  onSelect: (customer: CustomerRecord | null) => void;
};

/** How long the person has to stop typing before the search runs. */
const DEBOUNCE_MS = 250;

/** Most matches shown at once; the search asks the server for no more than this. */
const MAX_RESULTS = 8;

/** Find a customer by typing, or show the one already chosen. Each match is a button, so the keyboard reaches them. */
export function CustomerPicker({ selected, onSelect }: CustomerPickerProps) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');

  // The search waits until the person stops typing for a moment
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  // Nothing is searched while a customer is chosen
  const search = useCustomerSearch(selected === null ? query : '');

  if (selected !== null) {
    return (
      <div className={styles.picked} data-selected="true">
        <span className={styles.pickedName}>{selected.displayName}</span>
        <Button variant="ghost" onClick={() => onSelect(null)}>
          {create.newJob.changeCustomer}
        </Button>
      </div>
    );
  }

  const matches = search.data?.customers.slice(0, MAX_RESULTS) ?? [];
  const noMatches = search.isSuccess && query !== '' && matches.length === 0;

  return (
    <div className={styles.picker}>
      <Field
        label={create.newJob.searchCustomer}
        placeholder={create.newJob.searchPlaceholder}
        type="search"
        autoComplete="off"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      {search.isError ? (
        <p className={styles.note} role="alert">
          {errors.generic}
        </p>
      ) : null}
      {noMatches ? <p className={styles.note}>{create.newJob.noMatches}</p> : null}
      {matches.length > 0 ? (
        <ul className={styles.results}>
          {matches.map((customer) => (
            <li key={customer.id}>
              <Button variant="ghost" className={styles.result} onClick={() => onSelect(customer)}>
                {customer.displayName}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
