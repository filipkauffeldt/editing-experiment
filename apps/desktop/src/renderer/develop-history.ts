import type { EditParams, PhotoId } from '@ee/contracts';

/**
 * The develop settings of one photo as a step restores them. The parked values are the sliders of
 * switched-off sections: they are not in the sidecar, but a step that turns a section off or on
 * must bring the switch back with the settings it showed.
 */
export interface DevelopSettingsSnapshot {
  params: EditParams;
  /** Parked slider values of switched-off sections, by section title. */
  parked: Record<string, EditParams>;
}

/** Steps kept per photo. */
export const DEVELOP_HISTORY_STEP_LIMIT = 100;
/** Photos with a history kept at once; the least recently edited is dropped. */
export const DEVELOP_HISTORY_PHOTO_LIMIT = 200;
/** Arrow-key nudges on one slider within this quiet period are one step. */
export const DEVELOP_NUDGE_QUIET_MS = 600;

export interface RecordDevelopStepOptions {
  /** Changes to this parameter are one step while they keep coming. */
  nudgeKey?: string;
  /** Clock for tests; `Date.now()` otherwise. */
  now?: number;
}

interface DevelopStep {
  before: DevelopSettingsSnapshot;
  after: DevelopSettingsSnapshot;
  /** When the newest change of the step arrived. */
  at: number;
  /** The gesture the step belongs to, while a pointer or typed edit is open. */
  gesture?: number;
  nudgeKey?: string;
}

interface PhotoHistory {
  steps: DevelopStep[];
  redo: DevelopStep[];
}

const cloneParams = (params: EditParams): EditParams =>
  JSON.parse(JSON.stringify(params)) as EditParams;

export function cloneDevelopSnapshot(snapshot: DevelopSettingsSnapshot): DevelopSettingsSnapshot {
  const parked: Record<string, EditParams> = {};
  for (const [section, params] of Object.entries(snapshot.parked)) {
    parked[section] = cloneParams(params);
  }
  return { params: cloneParams(snapshot.params), parked };
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  for (const key of keys) {
    if (!sameValue(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

/** Whether two snapshots hold the same settings; a change that changes nothing is not a step. */
export function sameDevelopSnapshot(
  left: DevelopSettingsSnapshot,
  right: DevelopSettingsSnapshot,
): boolean {
  return sameValue(left, right);
}

/**
 * Per-photo undo and redo of develop settings, in memory for the session. A step records the
 * settings before and after a change, so undo restores absent keys as absent. Changes made during
 * one gesture (a slider drag, a typed value from focus to commit) coalesce into one step, and so
 * do a burst of arrow-key nudges on one parameter.
 */
export class DevelopHistory {
  private readonly histories = new Map<PhotoId, PhotoHistory>();
  /** A pointer drag, and a typed edit from focus to blur; a typed edit wins while both are open. */
  private pointerGesture: number | undefined;
  private typedGesture: number | undefined;
  private nextGestureId = 0;

  /** Open a pointer gesture: every change until {@link endGesture} is one step. */
  beginGesture(): void {
    this.pointerGesture = ++this.nextGestureId;
  }

  endGesture(): void {
    this.pointerGesture = undefined;
  }

  /** Open a typed edit: its live applies and the commit on blur are one step. */
  beginTypedEdit(): void {
    this.typedGesture = ++this.nextGestureId;
  }

  endTypedEdit(): void {
    this.typedGesture = undefined;
  }

  private activeGesture(): number | undefined {
    return this.typedGesture ?? this.pointerGesture;
  }

  /**
   * Record one change of `photoId`. Returns false when the snapshots are the same. A new step
   * clears the redo steps, as any change after an undo does.
   */
  record(
    photoId: PhotoId,
    before: DevelopSettingsSnapshot,
    after: DevelopSettingsSnapshot,
    options: RecordDevelopStepOptions = {},
  ): boolean {
    if (sameDevelopSnapshot(before, after)) return false;
    const history = this.histories.get(photoId) ?? { steps: [], redo: [] };
    const hadRedo = history.redo.length > 0;
    const now = options.now ?? Date.now();
    const gesture = this.activeGesture();
    const nudgeKey = gesture === undefined ? options.nudgeKey : undefined;
    const top = history.steps.at(-1);
    const sameGesture = top !== undefined && gesture !== undefined && top.gesture === gesture;
    const sameNudge =
      top !== undefined &&
      !hadRedo &&
      gesture === undefined &&
      top.gesture === undefined &&
      nudgeKey !== undefined &&
      top.nudgeKey === nudgeKey &&
      now - top.at <= DEVELOP_NUDGE_QUIET_MS;
    if (top && (sameGesture || sameNudge)) {
      const merged = cloneDevelopSnapshot(after);
      // A drag that comes back to where it started changed nothing.
      if (sameDevelopSnapshot(top.before, merged)) history.steps.pop();
      else {
        top.after = merged;
        top.at = now;
      }
    } else {
      history.steps.push({
        before: cloneDevelopSnapshot(before),
        after: cloneDevelopSnapshot(after),
        at: now,
        ...(gesture === undefined ? {} : { gesture }),
        ...(nudgeKey === undefined ? {} : { nudgeKey }),
      });
      if (history.steps.length > DEVELOP_HISTORY_STEP_LIMIT) history.steps.shift();
    }
    history.redo = [];
    this.touch(photoId, history);
    return true;
  }

  /** The settings to restore, or undefined when there is nothing to undo. */
  undo(photoId: PhotoId): DevelopSettingsSnapshot | undefined {
    const history = this.histories.get(photoId);
    const step = history?.steps.pop();
    if (!history || !step) return undefined;
    history.redo.push(step);
    this.touch(photoId, history);
    this.restartGesture();
    return cloneDevelopSnapshot(step.before);
  }

  /** The settings to restore again, or undefined when there is nothing to redo. */
  redo(photoId: PhotoId): DevelopSettingsSnapshot | undefined {
    const history = this.histories.get(photoId);
    const step = history?.redo.pop();
    if (!history || !step) return undefined;
    history.steps.push(step);
    this.touch(photoId, history);
    this.restartGesture();
    return cloneDevelopSnapshot(step.after);
  }

  canUndo(photoId: PhotoId): boolean {
    return (this.histories.get(photoId)?.steps.length ?? 0) > 0;
  }

  canRedo(photoId: PhotoId): boolean {
    return (this.histories.get(photoId)?.redo.length ?? 0) > 0;
  }

  undoDepth(photoId: PhotoId): number {
    return this.histories.get(photoId)?.steps.length ?? 0;
  }

  redoDepth(photoId: PhotoId): number {
    return this.histories.get(photoId)?.redo.length ?? 0;
  }

  /** Drop what is kept for a photo: it was deleted or removed from the Library. */
  forget(photoId: PhotoId): void {
    this.histories.delete(photoId);
  }

  /** The histories kept now, oldest first (for the bound and its test). */
  photos(): PhotoId[] {
    return [...this.histories.keys()];
  }

  /** Make an existing photo the most recently edited one. */
  private touch(photoId: PhotoId, history: PhotoHistory): void {
    this.histories.delete(photoId);
    this.histories.set(photoId, history);
    while (this.histories.size > DEVELOP_HISTORY_PHOTO_LIMIT) {
      const oldest = this.histories.keys().next().value;
      if (oldest === undefined) break;
      this.histories.delete(oldest);
    }
  }

  /** An undo mid-gesture starts a new gesture, so later changes do not merge into the undone step. */
  private restartGesture(): void {
    if (this.pointerGesture !== undefined) this.pointerGesture = ++this.nextGestureId;
    if (this.typedGesture !== undefined) this.typedGesture = ++this.nextGestureId;
  }
}
