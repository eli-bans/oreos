import { useEffect, useState } from 'react';
import styles from './Toaster.module.css';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  /** ms before auto-dismiss. 0 = sticky. Default 4000. */
  duration?: number;
}

type Subscriber = (toasts: Toast[]) => void;

let toastsRef: Toast[] = [];
const subscribers = new Set<Subscriber>();
let nextId = 1;

function emit() {
  for (const sub of subscribers) sub([...toastsRef]);
}

export function dismissToast(id: number) {
  toastsRef = toastsRef.filter((t) => t.id !== id);
  emit();
}

export function pushToast(t: Omit<Toast, 'id'>): number {
  const id = nextId++;
  const toast: Toast = { duration: 4000, ...t, id };
  toastsRef = [...toastsRef, toast];
  emit();
  if (toast.duration && toast.duration > 0) {
    window.setTimeout(() => dismissToast(id), toast.duration);
  }
  return id;
}

/** Convenience helpers — call from anywhere, no hook required. */
export const toast = {
  success: (title: string, description?: string) =>
    pushToast({ kind: 'success', title, description }),
  error: (title: string, description?: string) =>
    pushToast({ kind: 'error', title, description, duration: 6000 }),
  info: (title: string, description?: string) =>
    pushToast({ kind: 'info', title, description }),
};

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    subscribers.add(setItems);
    setItems([...toastsRef]);
    return () => {
      subscribers.delete(setItems);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className={styles.stack} aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`${styles.toast} ${styles[t.kind]}`} role="status">
          <span className={styles.icon} aria-hidden>
            {t.kind === 'success' ? '✓' : t.kind === 'error' ? '!' : 'i'}
          </span>
          <div className={styles.content}>
            <div className={styles.title}>{t.title}</div>
            {t.description && <div className={styles.description}>{t.description}</div>}
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
