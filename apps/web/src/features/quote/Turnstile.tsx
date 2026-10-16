import { useEffect, useRef } from 'react';

/*
 * Cloudflare Turnstile, only when the server returned a site key (TURNSTILE_SECRET and TURNSTILE_SITE_KEY set). The
 * script is loaded on demand from Cloudflare (the /q page's CSP allows it then) and the widget hands its one-use token
 * up; the server checks it. Without a site key this renders nothing and loads nothing.
 */

type TurnstileApi = {
  render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; 'expired-callback': () => void; 'error-callback': () => void }) => string;
  remove: (id: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')));
    s.onerror = () => reject(new Error('turnstile'));
    document.head.appendChild(s);
  });
  return loading;
}

export function Turnstile({ siteKey, onToken }: { siteKey: string | null; onToken: (token: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const tokenRef = useRef(onToken);
  useEffect(() => {
    tokenRef.current = onToken;
  }, [onToken]);
  useEffect(() => {
    if (siteKey === null || ref.current === null) return;
    const el = ref.current;
    let id: string | null = null;
    let gone = false;
    loadTurnstile().then(
      (api) => {
        if (gone) return;
        id = api.render(el, {
          sitekey: siteKey,
          callback: (t) => tokenRef.current(t),
          'expired-callback': () => tokenRef.current(''),
          'error-callback': () => tokenRef.current(''),
        });
      },
      () => undefined,
    );
    return () => {
      gone = true;
      if (id !== null) window.turnstile?.remove(id);
    };
  }, [siteKey]);
  return siteKey === null ? null : <div ref={ref} />;
}
