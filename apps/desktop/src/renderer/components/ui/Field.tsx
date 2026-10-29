import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import styles from './Field.module.css';

type Variant = 'underline' | 'boxed';

const inputClass = (variant: Variant, extra?: string): string =>
  [styles.input, variant === 'boxed' ? styles.boxed : '', extra ?? ''].filter(Boolean).join(' ');

/** Label above a control. Wrap an input from this module in it. */
export function Field({
  label,
  className,
  children,
}: {
  label: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`${styles.field} ${className ?? ''}`}>
      <span className={styles.label}>{label}</span>
      {children}
    </label>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & {
  variant?: Variant;
  className?: string;
};

/** Side panels use `underline` (a bottom hairline only); dialogs use `boxed`. */
export function TextInput({ variant = 'underline', className, ...rest }: InputProps) {
  return <input className={inputClass(variant, className)} {...rest} />;
}

type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & {
  variant?: Variant;
  className?: string;
};

export function TextArea({ variant = 'underline', className, ...rest }: TextAreaProps) {
  return <textarea className={inputClass(variant, className)} {...rest} />;
}

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> & {
  variant?: Variant;
  className?: string;
};

export function Select({ variant = 'underline', className, ...rest }: SelectProps) {
  return <select className={inputClass(variant, className)} {...rest} />;
}
