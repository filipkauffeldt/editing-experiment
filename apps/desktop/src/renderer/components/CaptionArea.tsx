import type { PhotoId } from '@ee/contracts';
import { mapCaretThrough } from '@ee/metadata/code-replacement-tokens';
import { useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { caretThroughChange, changedRange } from '../caption-expansion';
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

/** A code replacement that Ctrl+Z can take back, and where the caret was before it. */
interface ExpansionUndo {
  photoId: PhotoId;
  /** The text as typed, before the replacement. */
  before: string;
  /** The text the replacement made, which the field must still hold for the undo to apply. */
  after: string;
  start: number;
  end: number;
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
  /** The newest code replacement, until the next edit that is not its undo. */
  const lastExpansion = useRef<ExpansionUndo | undefined>(undefined);
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
    const before = area.value;
    replacing.current = true;
    try {
      replaceRange(area, hit.start, hit.end, hit.replacement);
    } finally {
      replacing.current = false;
    }
    lastExpansion.current = { photoId, before, after: area.value, start: caret, end: caret };
    store.updateMetadataField(photoId, 'caption', area.value);
  };

  /**
   * The browser's undo gives back the typed text but selects what the replacement had replaced.
   * Right after it, put the caret back where it was when the code was replaced.
   */
  const restoreCaretAfterUndo = (area: HTMLTextAreaElement): void => {
    const undone = lastExpansion.current;
    lastExpansion.current = undefined;
    if (undone?.photoId === photoId && area.value === undone.before) {
      area.setSelectionRange(undone.start, undone.end);
    }
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const area = event.currentTarget;
    const { inputType } = event.nativeEvent as InputEvent;
    store.updateMetadataField(photoId, 'caption', area.value);
    if (replacing.current) return;
    if (inputType === 'historyUndo') {
      restoreCaretAfterUndo(area);
      return;
    }
    lastExpansion.current = undefined;
    replaceTypedCode(area, event.nativeEvent as InputEvent);
  };

  /**
   * Ctrl+Space: expand every code and variable. The new text goes in as an edit of the field, not
   * as a new value, so the browser's undo stack survives and the next Ctrl+Z gives back the text
   * as it was typed.
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
      replacing.current = true;
      try {
        replaceRange(area, change.start, change.end, change.text);
      } finally {
        replacing.current = false;
      }
      lastExpansion.current = {
        photoId,
        before: text,
        after: result.text,
        start: selectionStart,
        end: selectionEnd,
      };
      store.updateMetadataField(photoId, 'caption', area.value);
      area.setSelectionRange(caret(selectionStart), caret(selectionEnd));
    }
    store.setUnresolvedCodes(photoId, result.unresolved);
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
      onBlur={() => {
        lastExpansion.current = undefined;
        // The expansion is part of the typing that led to it: one undo step for both.
        void store.expandCaption(photoId).finally(store.endMetadataTyping);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        if ((event.ctrlKey || event.metaKey) && event.key === ' ') {
          event.preventDefault();
          void expandAll(event.currentTarget);
        }
      }}
    />
  );
}
