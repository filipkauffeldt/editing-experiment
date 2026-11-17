import type { PhotoId } from '@ee/contracts';
import { mapCaretThrough } from '@ee/metadata/code-replacement-tokens';
import { useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import {
  caretThroughChange,
  changedRange,
  removeSpans,
  typedSpans,
  type Span,
} from '../caption-expansion';
import { useAppStore } from '../store-context';
import { TextArea } from './ui/Field';

const TYPED_DELETIONS: ReadonlySet<string> = new Set([
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
]);

/**
 * Put `replacement` where `[start, end)` is, as an edit the field's own undo stack knows
 * (Chromium: `insertText`, so Ctrl+Z gives back what was typed), and leave the caret right after
 * it. Where `execCommand` is missing (jsdom) or does nothing, `setRangeText` does the same edit.
 */
function replaceRange(area: HTMLTextAreaElement, start: number, end: number, text: string): void {
  const expected = area.value.slice(0, start) + text + area.value.slice(end);
  area.setSelectionRange(start, end);
  try {
    document.execCommand(text === '' ? 'delete' : 'insertText', false, text);
  } catch {
    // No execCommand here: the fallback below makes the edit.
  }
  if (area.value !== expected) area.setRangeText(text, start, end, 'end');
}

/** A selection `[start, end]` of the field. */
type Caret = readonly [number, number];

/**
 * The newest code replacement, for the Ctrl+Z that takes it out. That Ctrl+Z removes the codes
 * (and `{variables}`) the replacement wrote, as if they had never been typed, instead of giving
 * back the typed codes.
 */
interface Expansion {
  photoId: PhotoId;
  /** The text with the replacement in it, which the field must hold for Ctrl+Z to apply. */
  expanded: string;
  /** The typed text without the codes, and where the caret goes in it. */
  removed: string;
  removedCaret: Caret;
  /** Where the caret goes when Redo brings the replacement back. */
  expandedCaret: Caret;
  phase: 'expanded' | 'removed';
  /**
   * The field's own undo stack holds the typing and the replacement, so the next Ctrl+Z can go on
   * through it. Not after an expansion on blur, which sets the value and empties that stack.
   */
  native: boolean;
}

function expansionOf(
  photoId: PhotoId,
  typed: string,
  expanded: string,
  spans: readonly Span[],
  typedCaret: Caret,
  expandedCaret: Caret,
  native: boolean,
): Expansion | undefined {
  const removal = removeSpans(typed, spans);
  if (spans.length === 0 || removal.text === expanded) return undefined;
  return {
    photoId,
    expanded,
    removed: removal.text,
    removedCaret: [removal.caretAt(typedCaret[0]), removal.caretAt(typedCaret[1])],
    expandedCaret,
    phase: 'expanded',
    native,
  };
}

/**
 * The caption of the photo in the Metadata panel. A known `=code=` is replaced the moment a typed
 * edit (a character, Backspace, Delete) leaves the caret in it or right after it, so also when an
 * unknown token is edited into a known one; `{variables}` and unknown codes wait for blur or Ctrl+Space, which
 * expand everything.
 */
export function CaptionArea({
  photoId,
  value,
  placeholder,
  className,
}: {
  photoId: PhotoId;
  value: string;
  placeholder: string | undefined;
  className: string | undefined;
}) {
  const store = useAppStore();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /** Our own edit sends an `input` event of its own; it must not be read as typing. */
  const replacing = useRef(false);
  /** The newest code replacement, until the next edit of the field. */
  const expansion = useRef<Expansion | undefined>(undefined);

  /** An edit of the field's text that the browser's undo stack keeps as one step. */
  const edit = (area: HTMLTextAreaElement, start: number, end: number, text: string): void => {
    replacing.current = true;
    try {
      replaceRange(area, start, end, text);
    } finally {
      replacing.current = false;
    }
  };

  /** The browser's own undo, `times` steps. Its input events only sync the store. */
  const undoNatively = (times: number): void => {
    replacing.current = true;
    try {
      for (let step = 0; step < times; step++) document.execCommand('undo');
    } catch {
      // No execCommand here (jsdom): nothing to undo.
    } finally {
      replacing.current = false;
    }
  };

  const showCaret = (area: HTMLTextAreaElement, caret: Caret): void => {
    area.setSelectionRange(caret[0], caret[1]);
    store.updateMetadataField(photoId, 'caption', area.value);
  };
  const replaceTypedCode = (area: HTMLTextAreaElement, event: InputEvent): void => {
    // Only a typed edit: a character, or Backspace / Delete (also by word). Not a paste, a drop, an
    // undo or redo, a cut or composition (IME, dead keys): those wait for blur.
    if (event.isComposing) return;
    const typedCharacter = event.inputType === 'insertText' && event.data?.length === 1;
    if (!typedCharacter && !TYPED_DELETIONS.has(event.inputType)) return;
    const caret = area.selectionStart;
    if (caret !== area.selectionEnd) return;
    const hit = store.instantCodeReplacement(area.value, caret);
    if (!hit) return;
    const typed = area.value;
    edit(area, hit.start, hit.end, hit.replacement);
    expansion.current = expansionOf(
      photoId,
      typed,
      area.value,
      [{ from: hit.start, to: hit.end }],
      [caret, caret],
      [area.selectionStart, area.selectionEnd],
      true,
    );
    store.updateMetadataField(photoId, 'caption', area.value);
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const area = event.currentTarget;
    store.updateMetadataField(photoId, 'caption', area.value);
    if (replacing.current) return;
    expansion.current = undefined;
    replaceTypedCode(area, event.nativeEvent as InputEvent);
  };

  /**
   * Ctrl+Space: expand every code and variable. The new text goes in as an edit of the field, not
   * as a new value, so the browser's undo stack survives. The next Ctrl+Z takes the expansion out.
   */
  const expandAll = async (area: HTMLTextAreaElement): Promise<void> => {
    const { selectionStart, selectionEnd, value: text } = area;
    const result = await store.requestCaptionExpansion(photoId);
    if (!result || area.value !== text) return;
    if (document.activeElement !== area) {
      // Focus left while the answer was on its way: nothing to keep undoable in the field.
      store.updateMetadataField(photoId, 'caption', result.text);
      store.setUnresolvedCodes(photoId, result.unresolved);
      return;
    }
    if (result.text !== text) {
      const change = changedRange(text, result.text);
      const caret = (position: number): number =>
        result.edits
          ? mapCaretThrough(position, result.edits)
          : caretThroughChange(position, change);
      edit(area, change.start, change.end, change.text);
      const expandedCaret: Caret = [caret(selectionStart), caret(selectionEnd)];
      expansion.current = result.edits
        ? expansionOf(
            photoId,
            text,
            result.text,
            typedSpans(result.edits),
            [selectionStart, selectionEnd],
            expandedCaret,
            true,
          )
        : undefined;
      store.updateMetadataField(photoId, 'caption', area.value);
      area.setSelectionRange(expandedCaret[0], expandedCaret[1]);
    }
    store.setUnresolvedCodes(photoId, result.unresolved);
  };

  /** Blur: expand, and keep what a Ctrl+Z after coming back removes. */
  const expandOnBlur = (area: HTMLTextAreaElement): void => {
    const typed = area.value;
    const { selectionStart, selectionEnd } = area;
    expansion.current = undefined;
    // The expansion is part of the typing that led to it: one undo step for both.
    void store
      .expandCaption(photoId)
      .then((result) => {
        if (!result?.edits || result.text === typed) return;
        expansion.current = expansionOf(
          photoId,
          typed,
          result.text,
          typedSpans(result.edits),
          [selectionStart, selectionEnd],
          [
            mapCaretThrough(selectionStart, result.edits),
            mapCaretThrough(selectionEnd, result.edits),
          ],
          false,
        );
      })
      .finally(store.endMetadataTyping);
  };

  /**
   * Ctrl+Z right after a replacement takes the replacement out with the codes. The next one goes
   * on with the field's own undo, as if neither the codes nor their removal had happened.
   */
  const undoExpansion = (area: HTMLTextAreaElement): boolean => {
    const current = expansion.current;
    if (current?.photoId !== photoId) return false;
    if (current.phase === 'expanded' && area.value === current.expanded) {
      const change = changedRange(current.expanded, current.removed);
      edit(area, change.start, change.end, change.text);
      current.phase = 'removed';
      showCaret(area, current.removedCaret);
      return true;
    }
    if (current.phase === 'removed' && area.value === current.removed) {
      expansion.current = undefined;
      // The removal, the replacement and the typing of the codes.
      if (current.native) undoNatively(3);
      return true;
    }
    return false;
  };

  /**
   * Redo after that removal brings the replacement back. With the replacement showing there is
   * nothing to redo, and the browser's own redo would apply the removal again, so it is held back.
   */
  const redoExpansion = (area: HTMLTextAreaElement): boolean => {
    const current = expansion.current;
    if (current?.photoId !== photoId) return false;
    if (current.phase === 'expanded') return area.value === current.expanded;
    if (area.value !== current.removed) return false;
    undoNatively(1);
    if (area.value !== current.expanded) {
      const change = changedRange(area.value, current.expanded);
      edit(area, change.start, change.end, change.text);
    }
    current.phase = 'expanded';
    showCaret(area, current.expandedCaret);
    return true;
  };

  return (
    <TextArea
      ref={areaRef}
      className={className}
      data-caption-input
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      onFocus={() => void store.refreshCodeReplacements()}
      onBlur={(event) => expandOnBlur(event.currentTarget)}
      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        const area = event.currentTarget;
        const command = event.ctrlKey || event.metaKey;
        if (command && event.key === ' ') {
          event.preventDefault();
          void expandAll(area);
          return;
        }
        // AltGr is Ctrl+Alt on Windows and Linux and never a command.
        if (!command || event.altKey || event.nativeEvent.isComposing) return;
        const z = event.key === 'z' || event.key === 'Z';
        const y = event.key === 'y' || event.key === 'Y';
        const handled =
          (z && !event.shiftKey && undoExpansion(area)) ||
          ((y || (z && event.shiftKey)) && redoExpansion(area));
        if (handled) event.preventDefault();
      }}
    />
  );
}
