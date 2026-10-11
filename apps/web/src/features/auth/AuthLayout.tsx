import { Card } from '@roofline/ui';
import type { ReactNode } from 'react';
import { common } from '../../copy/common.ts';
import styles from './Auth.module.css';

/** The card every sign-in page sits in: the app's name, the page's title, then its content. */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <Card as="section" className={styles.card}>
        <p className={styles.brand}>{common.appName}</p>
        <h1 className={styles.title}>{title}</h1>
        {children}
      </Card>
    </main>
  );
}

/** A message about the whole form. Announced when it appears. Draws nothing without a message. */
export function FormAlert({ message }: { message: string | undefined }) {
  return message ? (
    <p role="alert" className={styles.alert}>
      {message}
    </p>
  ) : null;
}
