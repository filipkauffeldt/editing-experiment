import { useAppState, useAppStore } from '../store-context';
import { CheckIcon, CloseIcon, WarningIcon } from './icons';
import styles from './Toasts.module.css';

/** Dismissible job errors and short-lived success messages. */
export function Toasts() {
  const store = useAppStore();
  const { toasts } = useAppState();
  if (toasts.length === 0) return null;
  return (
    <div className={styles.stack} role="status" aria-live="polite" data-testid="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`${styles.toast} ${styles[toast.kind]}`}>
          <span className={styles.icon}>
            {toast.kind === 'error' ? <WarningIcon size={12} /> : <CheckIcon size={12} />}
          </span>
          <span className={styles.message}>{toast.message}</span>
          <button
            type="button"
            className={styles.close}
            aria-label="Dismiss message"
            onClick={() => store.dismissToast(toast.id)}
          >
            <CloseIcon size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}
