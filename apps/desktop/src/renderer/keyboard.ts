import { useEffect } from 'react';
import type { AppStore } from './store';

/** Focus the caption editor without threading a ref through every panel. */
export function focusCaptionField(): void {
  document.querySelector<HTMLTextAreaElement>('[data-caption-input]')?.focus();
}

function isTypingTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

/**
 * Global shortcuts. While an input, textarea, select or contenteditable has
 * focus only the explicit command shortcuts work (Ctrl/Cmd+Enter, Ctrl/Cmd+I,
 * Escape and Ctrl+Space inside the caption).
 */
export function useKeyboardShortcuts(store: AppStore): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = store.getState();
      const typing = isTypingTarget(event.target);
      const command = event.ctrlKey || event.metaKey;

      if (event.key === 'Escape') {
        if (state.crop && !typing && !state.dialog) {
          event.preventDefault();
          store.cancelCrop();
          return;
        }
        if (state.retouch && !typing && !state.dialog) {
          event.preventDefault();
          void store.requestExitRetouch();
          return;
        }
        if (state.shortcutsOpen) {
          event.preventDefault();
          store.toggleShortcuts(false);
          return;
        }
        if (state.dialog) return;
        if (typing) {
          event.preventDefault();
          event.target.blur();
        }
        return;
      }

      if (state.dialog || state.shortcutsOpen) return;

      if (command && event.key === 'Enter') {
        event.preventDefault();
        void store.finishAndNext();
        return;
      }
      if (command && (event.key === 'i' || event.key === 'I')) {
        event.preventDefault();
        focusCaptionField();
        return;
      }
      if (command && (event.key === 'z' || event.key === 'Z') && state.retouch) {
        event.preventDefault();
        store.undoRetouchShape();
        return;
      }

      if (typing) return;
      if (state.crop && event.key === 'Enter') {
        event.preventDefault();
        store.applyCrop();
        return;
      }
      // Single-key shortcuts never fire with a command modifier, during IME
      // composition, or for the synthetic keydown an IME emits on commit.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.repeat && (event.key === 't' || event.key === 'T')) return;

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          store.selectRelative(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          store.selectRelative(1);
          break;
        case '?':
        case '/':
          if (event.key === '/' && !event.shiftKey) break;
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
          store.toggleRetouch();
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
