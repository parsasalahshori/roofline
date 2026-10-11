import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CloseIcon } from '../../close-icon.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import styles from './Toast.module.css';

export type ToastTone = 'info' | 'success' | 'error';

export type ToastApi = {
  /** Shows a message for six seconds. The same message showing already is not added again: its time restarts. */
  show: (message: string, tone?: ToastTone) => void;
};

export type ToastProviderProps = {
  children: ReactNode;
  /** The accessible name of each toast's close button. */
  closeLabel: string;
};

type ToastItem = { id: number; message: string; tone: ToastTone };

/** How long a toast stays, in milliseconds. */
const DISMISS_AFTER = 6000;

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Shows short messages in the corner. Errors go to a role="alert" region and everything else to a
 * role="status" one. Both regions are on the page from the first render, empty, because a screen
 * reader announces what is inserted into a live region it already knows, not a new one.
 */
export function ToastProvider({ children, closeLabel }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // The message is the key: a repeated message finds its running timer and restarts it
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const nextId = useRef(0);

  const dismiss = useCallback((message: string) => {
    const timer = timers.current.get(message);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(message);
    setToasts((current) => current.filter((toast) => toast.message !== message));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const running = timers.current.get(message);
      if (running !== undefined) clearTimeout(running);
      timers.current.set(
        message,
        setTimeout(() => dismiss(message), DISMISS_AFTER),
      );
      // Taken out here, not in the updater, which React may call twice
      const id = nextId.current++;
      setToasts((current) =>
        current.some((toast) => toast.message === message)
          ? current.map((toast) => (toast.message === message ? { ...toast, tone } : toast))
          : [...current, { id, message, tone }],
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const running = timers.current;
    return () => {
      running.forEach((timer) => clearTimeout(timer));
      running.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  function renderToast(toast: ToastItem) {
    return (
      <div key={toast.id} className={styles.toast} data-tone={toast.tone}>
        <p className={styles.message}>{toast.message}</p>
        <IconButton label={closeLabel} icon={<CloseIcon />} onClick={() => dismiss(toast.message)} />
      </div>
    );
  }

  return (
    <ToastContext value={api}>
      {children}
      <div className={styles.viewport}>
        {/* aria-atomic false: announce the toast that arrived, not every toast on screen again */}
        <div role="status" aria-atomic="false" className={styles.region}>
          {toasts.filter((toast) => toast.tone !== 'error').map(renderToast)}
        </div>
        <div role="alert" aria-atomic="false" className={styles.region}>
          {toasts.filter((toast) => toast.tone === 'error').map(renderToast)}
        </div>
      </div>
    </ToastContext>
  );
}

/** The toast API. It must be used under a ToastProvider. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast needs a ToastProvider above it in the tree.');
  return api;
}
