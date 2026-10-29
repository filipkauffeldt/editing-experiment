import styles from './Dot.module.css';

/** A 6-7 px status or colour-class dot. The only places colour appears besides the photo. */
export function Dot({
  tone,
  color,
  size = 6,
  title,
}: {
  tone?: 'ok' | 'error' | 'idle';
  /** CSS colour for colour classes. */
  color?: string;
  size?: 6 | 7;
  title?: string;
}) {
  return (
    <span
      className={`${styles.dot} ${tone ? styles[tone] : ''}`}
      style={{ width: size, height: size, background: color }}
      title={title}
      aria-hidden={title ? undefined : true}
    />
  );
}
