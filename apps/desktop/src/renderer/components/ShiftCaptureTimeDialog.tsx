import type { Photo } from '@ee/contracts';
import {
  formatCaptureDateTime,
  parseCaptureDateTime,
  shiftCaptureDateTime,
} from '@ee/metadata/capture-time-value';
import { useEffect, useMemo, useState } from 'react';
import { useAppState, useAppStore } from '../store-context';
import { Modal } from './Modal';
import { Button } from './ui/Button';
import { Select, TextInput } from './ui/Field';
import styles from './ShiftCaptureTimeDialog.module.css';

type Sign = '+' | '-';

const hasClockTime = (photo: Photo | undefined): boolean =>
  photo?.captureTime !== undefined && parseCaptureDateTime(photo.captureTime) !== undefined;

const shown = (value: string): string => value.replace('T', ' ');

/** Digits only, at most `length` characters; empty stays empty until the field is left. */
function digits(text: string, length: number): string {
  return text.replace(/\D/g, '').slice(0, length);
}

/** Minute and second fields are 0-59; an empty field counts as zero in the preview. */
function unit(text: string): number {
  const value = Number(text);
  return Number.isFinite(value) ? Math.min(59, Math.max(0, Math.round(value))) : 0;
}

function hours(text: string): number {
  const value = Number(text);
  return Number.isFinite(value) ? Math.min(999, Math.max(0, Math.round(value))) : 0;
}

/**
 * Moves the capture time of the photos the right-click menu was opened on. The time is always
 * relative to each photo's own clock, so the same offset applied twice moves it twice.
 */
export function ShiftCaptureTimeDialog() {
  const store = useAppStore();
  const state = useAppState();
  const request = state.captureTimeShift;
  const [sign, setSign] = useState<Sign>('+');
  const [h, setH] = useState('0');
  const [m, setM] = useState('0');
  const [s, setS] = useState('0');

  const targets = useMemo(
    () =>
      (request?.photoIds ?? [])
        .map((photoId) => state.photos.find((photo) => photo.id === photoId))
        .filter((photo): photo is Photo => photo !== undefined),
    [request, state.photos],
  );
  const active = targets.find((photo) => photo.id === state.selectedId) ?? targets[0];
  const withTime = targets.filter(hasClockTime);
  const offsetSeconds = (sign === '-' ? -1 : 1) * (hours(h) * 3600 + unit(m) * 60 + unit(s));
  const before = active?.captureTime;
  const after = useMemo(() => {
    if (before === undefined) return undefined;
    const parts = parseCaptureDateTime(before);
    if (parts === undefined) return undefined;
    return formatCaptureDateTime(shiftCaptureDateTime(parts, offsetSeconds));
  }, [before, offsetSeconds]);
  const busy = request?.busy ?? false;
  const disabled = busy || withTime.length === 0 || offsetSeconds === 0;

  // Enter applies wherever the focus is, except on Cancel, which Enter presses.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.isComposing || event.repeat) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.dataset.captureTimeCancel !== undefined
      ) {
        return;
      }
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      void store.confirmCaptureTimeShift(offsetSeconds);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [store, disabled, offsetSeconds]);

  if (!request) return null;
  const missing = targets.length - withTime.length;
  return (
    <Modal
      title="Shift capture time"
      subtitle={active?.fileName}
      onClose={() => store.cancelCaptureTimeShift()}
      width={430}
      testId="shift-capture-time-dialog"
      footer={
        <>
          <span className={styles.spacer} />
          <Button
            data-capture-time-cancel
            disabled={busy}
            onClick={() => store.cancelCaptureTimeShift()}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            autoFocus
            disabled={disabled}
            data-testid="shift-capture-time-apply"
            onClick={() => void store.confirmCaptureTimeShift(offsetSeconds)}
          >
            {busy
              ? 'Shifting…'
              : `Shift ${withTime.length} photo${withTime.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.offsetRow}>
          <span className={styles.label}>Offset</span>
          <Select
            variant="boxed"
            className={styles.sign}
            aria-label="Direction"
            value={sign}
            disabled={busy}
            onChange={(event) => setSign(event.target.value as Sign)}
          >
            <option value="+">+</option>
            <option value="-">−</option>
          </Select>
          <TextInput
            variant="boxed"
            className={`${styles.number} mono`}
            inputMode="numeric"
            aria-label="Hours"
            data-testid="shift-capture-time-hours"
            value={h}
            maxLength={3}
            disabled={busy}
            onChange={(event) => setH(digits(event.target.value, 3))}
            onBlur={() => setH(String(hours(h)))}
          />
          <span className={styles.unit}>h</span>
          <TextInput
            variant="boxed"
            className={`${styles.number} mono`}
            inputMode="numeric"
            aria-label="Minutes"
            data-testid="shift-capture-time-minutes"
            value={m}
            maxLength={2}
            disabled={busy}
            onChange={(event) => setM(digits(event.target.value, 2))}
            onBlur={() => setM(String(unit(m)))}
          />
          <span className={styles.unit}>min</span>
          <TextInput
            variant="boxed"
            className={`${styles.number} mono`}
            inputMode="numeric"
            aria-label="Seconds"
            data-testid="shift-capture-time-seconds"
            value={s}
            maxLength={2}
            disabled={busy}
            onChange={(event) => setS(digits(event.target.value, 2))}
            onBlur={() => setS(String(unit(s)))}
          />
          <span className={styles.unit}>s</span>
        </div>

        <div className={styles.preview} data-testid="shift-capture-time-preview">
          <span className={styles.previewLabel}>Now</span>
          <span className="mono">{before === undefined ? 'No capture time' : shown(before)}</span>
          <span className={styles.previewLabel}>After</span>
          <span className="mono">{after === undefined ? 'No capture time' : shown(after)}</span>
        </div>

        <p className={styles.summary}>
          {withTime.length} photo{withTime.length === 1 ? '' : 's'} will change.
          {missing > 0 && (
            <span className={styles.note}>
              {' '}
              {missing} photo{missing === 1 ? '' : 's'} {missing === 1 ? 'has' : 'have'} no capture
              time and {missing === 1 ? 'is' : 'are'} left alone.
            </span>
          )}
        </p>
        <p className={styles.note}>
          Each photo moves from its own time, so the opposite offset takes it back.
        </p>
      </div>
    </Modal>
  );
}
