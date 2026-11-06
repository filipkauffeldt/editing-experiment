import type { PhotoId } from '@ee/contracts';
import { mapCaretThrough } from '@ee/metadata/code-replacement-tokens';
import { useLayoutEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { useAppStore } from '../store-context';
import { TextArea } from './ui/Field';

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

/**
 * The caption of the photo in the Metadata panel. A known `=code=` is replaced the moment its
 * closing delimiter is typed; `{variables}` and unknown codes wait for blur or Ctrl+Space, which
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
  /** Where the selection goes once the expanded text is in the field (Ctrl+Space). */
  const pendingSelection = useRef<{ photoId: PhotoId; start: number; end: number } | undefined>(
    undefined,
  );

  // React replaces the value of the field, which puts the caret at its end; set it back.
  useLayoutEffect(() => {
    const area = areaRef.current;
    const selection = pendingSelection.current;
    if (!area || !selection) return;
    if (selection.photoId !== photoId) pendingSelection.current = undefined;
    if (selection.photoId !== photoId || area.value !== value) return;
    pendingSelection.current = undefined;
    if (document.activeElement === area) area.setSelectionRange(selection.start, selection.end);
  }, [value, photoId]);

  const replaceTypedCode = (area: HTMLTextAreaElement, event: InputEvent): void => {
    // Only a typed character: not a paste, a drop, an undo, a deletion or composition (IME, dead keys).
    if (event.inputType !== 'insertText' || event.isComposing || event.data?.length !== 1) return;
    const caret = area.selectionStart;
    if (caret !== area.selectionEnd) return;
    const hit = store.instantCodeReplacement(area.value, caret);
    if (!hit) return;
    replacing.current = true;
    try {
      replaceRange(area, hit.start, hit.end, hit.replacement);
    } finally {
      replacing.current = false;
    }
    store.updateMetadataField(photoId, 'caption', area.value);
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const area = event.currentTarget;
    store.updateMetadataField(photoId, 'caption', area.value);
    if (!replacing.current) replaceTypedCode(area, event.nativeEvent as InputEvent);
  };

  const expandAll = async (area: HTMLTextAreaElement): Promise<void> => {
    // The caret is read before the text is replaced: React puts it at the end when it does.
    const { selectionStart, selectionEnd } = area;
    const result = await store.expandCaption(photoId);
    if (!result?.edits || document.activeElement !== area) return;
    pendingSelection.current = {
      photoId,
      start: mapCaretThrough(selectionStart, result.edits),
      end: mapCaretThrough(selectionEnd, result.edits),
    };
    // The new text may already be in the field (React rendered before this ran).
    if (area.value === result.text) {
      const { start, end } = pendingSelection.current;
      pendingSelection.current = undefined;
      area.setSelectionRange(start, end);
    }
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
      onBlur={() => void store.expandCaption(photoId)}
      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        if ((event.ctrlKey || event.metaKey) && event.key === ' ') {
          event.preventDefault();
          void expandAll(event.currentTarget);
        }
      }}
    />
  );
}
