import { useEffect, useRef, useState } from 'react';
import { Button } from '@roofline/ui';
import { auth } from '../../copy/auth.ts';
import styles from './GoogleButton.module.css';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: { client_id: string; callback: (response: { credential: string }) => void }): void;
          renderButton(parent: HTMLElement, options: { type: 'standard'; text: 'continue_with'; width: number }): void;
        };
      };
    };
  }
}

const GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client';

/** The one load of Google's script for the page. A failed load clears it so the next mount can retry. */
let loader: Promise<void> | null = null;

function loadGoogle(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (loader === null) {
    loader = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GOOGLE_SCRIPT;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        loader = null;
        script.remove();
        reject(new Error('Google sign-in script failed to load'));
      };
      document.head.append(script);
    });
  }
  return loader;
}

/** Google's own sign-in button. It shows nothing when the server has no Google client id. */
export function GoogleButton({ clientId, onCredential }: { clientId: string | null; onCredential: (credential: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const credentialRef = useRef(onCredential);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    credentialRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    if (clientId === null) return;
    let cancelled = false;
    loadGoogle().then(
      () => {
        const container = containerRef.current;
        const google = window.google;
        if (cancelled || container === null || google === undefined) return;
        google.accounts.id.initialize({
          client_id: clientId,
          callback: ({ credential }) => credentialRef.current(credential),
        });
        container.replaceChildren();
        google.accounts.id.renderButton(container, { type: 'standard', text: 'continue_with', width: 280 });
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  if (clientId === null) return null;
  if (failed) {
    return (
      <Button variant="ghost" disabled>
        {auth.googleFallback}
      </Button>
    );
  }
  return <div ref={containerRef} className={styles.wrap} />;
}
