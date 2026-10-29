import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  /** `primary` is white on near-black and appears at most once per bar or dialog. */
  variant?: 'default' | 'primary' | 'ghost';
  size?: 'normal' | 'small';
  /** Pressed state of a toggle, drawn as a white outline. */
  active?: boolean;
  /** Keyboard hint shown dimmed after the label. */
  hint?: string;
  className?: string;
  children: ReactNode;
}

/** Square-cornered button; the only filled one is the primary action. */
export function Button({
  variant = 'default',
  size = 'normal',
  active,
  hint,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    variant === 'primary' ? styles.primary : '',
    variant === 'ghost' ? styles.ghost : '',
    size === 'small' ? styles.small : '',
    active ? styles.active : '',
    className ?? '',
  ];
  return (
    <button type={type} className={classes.filter(Boolean).join(' ')} {...rest}>
      {children}
      {hint && <span className={styles.hint}>{hint}</span>}
    </button>
  );
}
