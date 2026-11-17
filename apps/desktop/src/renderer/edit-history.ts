import type { PhotoId } from '@ee/contracts';

/** Steps kept; the oldest is dropped past this. */
export const EDIT_HISTORY_LIMIT = 200;

/**
 * One undoable change to labels or metadata, possibly on many photos. `undo` and `redo` write the
 * values through the same persistence path as the change itself and resolve once they are saved.
 */
export interface EditStep {
  /** What changed, for the toast: "rating", "caption", "colour label". */
  what: string;
  /** The photos the step restores, for the toast ("12 photos"). */
  photoIds: readonly PhotoId[];
  /** {@link nextChangeOrder} of the step's newest change, to order it against a develop step. */
  order: number;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

/**
 * The app-wide undo history of tags, ratings, colour labels, captions and keywords for the
 * session. Develop and Retouch keep their own history; the store picks between them by which change was newer.
 * Undo and redo run one after another, so two quick key presses never overlap their writes.
 */
export class EditHistory {
  private done: EditStep[] = [];
  private undone: EditStep[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  /** Add a change. Anything that was undone and not redone can not be redone any more. */
  record(step: EditStep): void {
    this.done.push(step);
    if (this.done.length > EDIT_HISTORY_LIMIT) this.done.shift();
    this.undone = [];
  }

  /** Take a step out again, for a typed change that ended where it started. */
  discard(step: EditStep): void {
    const index = this.done.lastIndexOf(step);
    if (index >= 0) this.done.splice(index, 1);
  }

  /** Whether `step` is the newest change, so a typed edit may still grow it. */
  isLast(step: EditStep): boolean {
    return this.done.at(-1) === step;
  }

  /** The order of the step an undo would take back; undefined with nothing to undo. */
  undoOrder(): number | undefined {
    return this.done.at(-1)?.order;
  }

  canUndo(): boolean {
    return this.done.length > 0;
  }

  canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Undo the newest step; resolves with it, or undefined when there was none. */
  undo(): Promise<EditStep | undefined> {
    return this.run(() => {
      const step = this.done.pop();
      if (!step) return undefined;
      this.undone.push(step);
      return step.undo().then(() => step);
    });
  }

  /** Redo the step the last undo took back. */
  redo(): Promise<EditStep | undefined> {
    return this.run(() => {
      const step = this.undone.pop();
      if (!step) return undefined;
      this.done.push(step);
      return step.redo().then(() => step);
    });
  }

  /** Run after everything queued before, whether that failed or not. */
  private run(action: () => Promise<EditStep> | undefined): Promise<EditStep | undefined> {
    const result = this.chain.then(action, action);
    this.chain = result.catch(() => undefined);
    return result;
  }
}
