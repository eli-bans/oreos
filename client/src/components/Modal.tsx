import { useEffect, useRef } from 'react';
import styles from './Modal.module.css';

type ModalSize = 'sm' | 'md' | 'lg';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  size?: ModalSize;
  /** If false, clicking the backdrop won't close the modal. Default true. */
  closeOnBackdrop?: boolean;
  /** Action buttons rendered in the footer, right-aligned. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Lightweight accessible-ish modal.
 * - Esc closes
 * - Backdrop click closes (unless closeOnBackdrop=false)
 * - Auto-focuses the first focusable element inside the body
 * - Restores focus to the previously-focused element on close
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  closeOnBackdrop = true,
  footer,
  children,
}: ModalProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);

    // Focus the first focusable element after paint
    const t = window.setTimeout(() => {
      const root = bodyRef.current;
      if (!root) return;
      const focusable = root.querySelector<HTMLElement>(
        'input, textarea, select, button:not([data-dismiss]), [tabindex]:not([tabindex="-1"])'
      );
      focusable?.focus();
    }, 0);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.clearTimeout(t);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className={`${styles.modal} ${styles[size]}`} ref={bodyRef}>
        {(title || subtitle) && (
          <header className={styles.header}>
            {title && <h2 className={styles.title}>{title}</h2>}
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </header>
        )}
        <div className={styles.body}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </div>
  );
}
