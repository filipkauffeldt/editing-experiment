import { useEffect } from 'react';
import {
  cancelWbPicker,
  developViewStore,
  toggleBefore,
  toggleClipping,
  toggleWbPicker,
} from './develop-view';
import type { AppStore } from './store';

/** Focus the caption editor without threading a ref through every panel. */
export function focusCaptionField(): void {
  document.querySelector<HTMLTextAreaElement>('[data-caption-input]')?.focus();
}

/**
 * Symbols that a Swedish (and most non-US) layout only produces with AltGr.
 * Windows/Linux report AltGr as Ctrl+Alt, so a combo carrying one of these is
 * character input, never a command.
 */
const ALT_GRAPH_SYMBOLS = new Set(['@', '$', '{', '[', ']', '}', '\\', '|', '~', '€']);

const wbPickerOpen = (): boolean => developViewStore.get().wbPicker;

function isAltGraph(event: KeyboardEvent): boolean {
  if (event.getModifierState?.('AltGraph') === true) return true;
  // Some drivers do not report AltGraph; a Ctrl+Alt combo that does not type a
  // plain letter or digit is a character on those layouts too.
  return (
    event.ctrlKey &&
    event.altKey &&
    (ALT_GRAPH_SYMBOLS.has(event.key) || !/^[a-z0-9]$/i.test(event.key))
  );
}

/** Letters and digits match what the keyboard prints, in any layout. */
const keyIs = (event: KeyboardEvent, key: string): boolean =>
  event.key.toLowerCase() === key.toLowerCase();

function isTypingTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  // A checkbox takes no text, so the shortcuts keep working after it is clicked.
  if (target instanceof HTMLInputElement && target.type === 'checkbox') return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

/**
 * Whether a key event would type text. Sliders, checkboxes and buttons are not
 * text entry, so command shortcuts stay available after using them.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(
      target.type,
    );
  }
  return target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
}

/**
 * Global shortcuts. While an input, textarea, select or contenteditable has
 * focus only the explicit command shortcuts work (Ctrl/Cmd+Enter, Ctrl/Cmd+I,
 * Shift+Ctrl/Cmd+Enter, Shift+Ctrl/Cmd+E, Escape and Ctrl+Space inside the caption).
 */
export function useKeyboardShortcuts(store: AppStore): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = store.getState();
      const typing = isTypingTarget(event.target);
      const textEntry = isTextEntryTarget(event.target);
      const altGraph = isAltGraph(event);
      const command = event.ctrlKey || event.metaKey;

      if (event.key === 'Escape') {
        if (!typing && !state.dialog && wbPickerOpen()) {
          event.preventDefault();
          cancelWbPicker();
          return;
        }
        if (state.crop && !typing && !state.dialog && !state.copySettings) {
          event.preventDefault();
          store.cancelCrop();
          return;
        }
        if (state.retouch && !typing && !state.dialog && !state.copySettings) {
          event.preventDefault();
          void store.requestExitRetouch();
          return;
        }
        if (state.shortcutsOpen) {
          event.preventDefault();
          store.toggleShortcuts(false);
          return;
        }
        if (state.dialog || state.copySettings || state.exportOpen || state.batchCaptionOpen)
          return;
        if (state.module === 'library' && !typing && state.selection.length > 1) {
          event.preventDefault();
          store.clearLibrarySelection();
          return;
        }
        if (typing) {
          event.preventDefault();
          event.target.blur();
        }
        return;
      }

      // A dead key (Swedish ¨, ´ …) or an IME composition must reach the field,
      // and AltGr is a character modifier: neither may fire a shortcut.
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.key === 'Dead' ||
        event.key === 'Process'
      )
        return;
      if (isAltGraph(event)) return;

      if (
        state.dialog ||
        state.copySettings ||
        state.shortcutsOpen ||
        state.exportOpen ||
        state.batchCaptionOpen
      )
        return;

      const library = state.module === 'library';
      // The physical slash key, so the shortcut does not depend on where `/` sits.
      if (command && event.code === 'Slash') {
        event.preventDefault();
        store.toggleShortcuts(true);
        return;
      }
      if (command && event.shiftKey && (event.key === 'e' || event.key === 'E')) {
        event.preventDefault();
        store.openExportDialog();
        return;
      }
      if (command && event.shiftKey && event.key === 'Enter') {
        event.preventDefault();
        void store.exportSelected(true);
        return;
      }
      // Next & send belongs to Develop; the Library exports with Shift only.
      if (command && event.key === 'Enter') {
        event.preventDefault();
        if (!library) void store.nextAndSend();
        return;
      }
      if (command && (event.key === 'i' || event.key === 'I')) {
        event.preventDefault();
        if (library) store.toggleBatchCaption(true);
        else if (state.module === 'develop') focusCaptionField();
        return;
      }
      if (library && !typing && command && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault();
        store.selectAllInLibrary();
        return;
      }
      if (command && (event.key === 'z' || event.key === 'Z') && state.retouch) {
        event.preventDefault();
        store.undoRetouchShape();
        return;
      }

      // Copy/paste develop settings. AltGr (Ctrl+Alt on Windows/Linux) is not a
      // command shortcut, and text fields keep their own paste behaviour.
      if (!textEntry && !altGraph) {
        if (
          command &&
          event.shiftKey &&
          !event.altKey &&
          (event.key === 'c' || event.key === 'C')
        ) {
          event.preventDefault();
          store.openCopySettings('copy');
          return;
        }
        if (
          command &&
          event.shiftKey &&
          !event.altKey &&
          (event.key === 'v' || event.key === 'V')
        ) {
          event.preventDefault();
          store.pasteSettings();
          return;
        }
        // `code`, because Option+V types another character on macOS. AltGr is
        // Ctrl+Alt on Windows/Linux, so the AltGraph check above keeps it out.
        if (command && event.altKey && !event.shiftKey && event.code === 'KeyV') {
          event.preventDefault();
          store.pastePreviousSettings();
          return;
        }
      }

      if (event.key === 'F1') {
        event.preventDefault();
        store.toggleShortcuts(true);
        return;
      }

      if (typing) return;
      if (state.crop && event.key === 'Enter') {
        event.preventDefault();
        store.applyCrop();
        return;
      }
      // Ctrl/Cmd+Alt+R resets the crop. `code`, because Option+R types another character on macOS.
      if (state.crop && command && event.altKey && event.code === 'KeyR') {
        event.preventDefault();
        store.resetCrop();
        return;
      }
      // Single-key shortcuts never fire with a command modifier, during IME
      // composition, or for the synthetic keydown an IME emits on commit.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.repeat && keyIs(event, 't')) return;

      const developing = state.module === 'develop' && !state.crop && !state.retouch;
      if (developing && (event.code === 'Backslash' || event.code === 'IntlBackslash')) {
        event.preventDefault();
        toggleBefore();
        return;
      }
      if (developing && keyIs(event, 'y')) {
        event.preventDefault();
        toggleBefore();
        return;
      }
      if (developing && keyIs(event, 'j')) {
        event.preventDefault();
        toggleClipping();
        return;
      }
      if (developing && keyIs(event, 'w')) {
        event.preventDefault();
        toggleWbPicker();
        return;
      }

      if (state.module === 'ingest') {
        // Ingest has no photos to cull; only the module keys apply.
        if (keyIs(event, 'g')) store.openLibrary('grid');
        else if (keyIs(event, 'd')) store.setModule('develop');
        return;
      }

      switch (event.key) {
        case 'g':
        case 'G':
          event.preventDefault();
          store.openLibrary('grid');
          break;
        case 'd':
        case 'D':
          event.preventDefault();
          store.setModule('develop');
          break;
        case 'e':
        case 'E':
          event.preventDefault();
          store.openLibrary('loupe');
          break;
        case 'ArrowLeft':
          event.preventDefault();
          if (library) store.moveInLibrary(-1, event.shiftKey);
          else store.selectRelative(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          if (library) store.moveInLibrary(1, event.shiftKey);
          else store.selectRelative(1);
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          if (!library || state.library.view !== 'grid') break;
          event.preventDefault();
          store.moveRowInLibrary(event.key === 'ArrowUp' ? -1 : 1, event.shiftKey);
          break;
        case '?':
          event.preventDefault();
          store.toggleShortcuts(true);
          break;
        case 't':
        case 'T':
          event.preventDefault();
          store.toggleTag();
          break;
        case 'r':
        case 'R':
          event.preventDefault();
          // In crop mode R is Lightroom's crop frame tool; retouch is off limits there.
          if (state.crop) store.toggleCropTool('draw');
          else store.toggleRetouch();
          break;
        case 'a':
        case 'A':
          if (!state.crop) break;
          event.preventDefault();
          store.toggleCropTool('straighten');
          break;
        case 'o':
        case 'O':
          if (!state.crop) break;
          event.preventDefault();
          store.cycleCropOverlay();
          break;
        case 'c':
        case 'C':
          event.preventDefault();
          store.toggleCrop();
          break;
        case 'x':
        case 'X':
          if (!state.crop) break;
          event.preventDefault();
          store.swapCropOrientation();
          break;
        default:
          if (/^[0-8]$/.test(event.key)) {
            event.preventDefault();
            store.setColorClass(Number(event.key));
          }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store]);
}
